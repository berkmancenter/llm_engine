/**
 * The composed bot-media-server application: HTTP static/page serving plus socket.io wiring
 * for both the browser page and the llm_engine connection.
 *
 * Exported as a function — rather than run as a top-level script  —
 * so it can be started against an OS-assigned port with an injected (fake, in
 * tests) AuthManager and TTS function. See bot-media-server/tests/app.test.ts.
 * server.ts is the thin CLI entrypoint: it reads env vars, does the real login, and calls
 * startBotMediaApp with the result.
 */
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Server as SocketIOServer } from 'socket.io'
import { Socket } from 'socket.io-client'
import { AuthManager } from './auth.js'
import { PendingQueue, CALL_UPON_TTL_MS } from './pendingQueue.js'
import { createEngineSocket, AudioChunk } from './engineSocket.js'
import PAGE from './page.js'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dir, 'public')

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
}

export interface BotMediaAppConfig {
  llmEngineWsUrl: string
  // 0 lets the OS assign a free port — tests do this rather than hardcoding one.
  port: number
  // Already logged in — a test injects a fake with a canned getAccessToken()/
  // refreshAccessToken(), avoiding any real login call.
  auth: AuthManager
  // The real entrypoint (server.ts) builds this via tts/index.ts's createTts(), per
  // TTS_ENGINE. A test injects a fake so it doesn't depend on macOS, spawn a subprocess, or
  // load a model.
  tts: (text: string) => Promise<Buffer>
  // How long to keep a conversation's engine socket and held audio alive after its last
  // browser client disconnects, in case that was a page refresh rather than the bot leaving
  // for good — see the disconnect handler below. Defaults to CALL_UPON_TTL_MS: a held
  // response's own TTL timer keeps running whether or not a browser is connected, so there's
  // no benefit to a shorter grace period.
  reconnectGraceMs?: number
  onLog?: (message: string) => void
}

export interface BotMediaApp {
  httpServer: http.Server
  browserIO: SocketIOServer
  stop(): Promise<void>
}

export async function startBotMediaApp(config: BotMediaAppConfig): Promise<BotMediaApp> {
  const log = config.onLog ?? (() => {})
  const { tts } = config
  const reconnectGraceMs = config.reconnectGraceMs ?? CALL_UPON_TTL_MS

  const httpServer = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? '/', `http://localhost`)
    const urlPath = parsed.pathname

    if (urlPath === '/' || urlPath === '') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(PAGE)
      return
    }

    // Liveness probe. Auth and TTS are both already confirmed working by the time this
    // process is listening at all (server.ts awaits login() and createTts() before calling
    // startBotMediaApp) — nothing further to check here, so this is deliberately just "is the
    // HTTP server itself responding".
    if (urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath))
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403)
      res.end()
      return
    }
    // filePath is already confirmed to stay within PUBLIC_DIR above — no path traversal.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end()
        return
      }
      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' })
      res.end(data)
    })
  })

  const browserIO = new SocketIOServer(httpServer, { cors: { origin: '*' } })

  function pushState(conversationId: string, state: 'idle' | 'hand-raised' | 'speaking') {
    log(`${conversationId} state → ${state}`)
    browserIO.to(conversationId).emit('state', { state })
  }

  const engineSockets = new Map<string, Socket>()
  const pendingQueues = new Map<string, PendingQueue<AudioChunk>>()
  const teardownTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function createEngineSocketFor(conversationId: string, botName: string, passcodes: { transcriptPasscode?: string } = {}) {
    const { socket, queue } = createEngineSocket(
      {
        llmEngineWsUrl: config.llmEngineWsUrl,
        conversationId,
        botName,
        transcriptPasscode: passcodes.transcriptPasscode,
        auth: config.auth,
        tts,
        onLog: log
      },
      {
        onStateChange: (state) => pushState(conversationId, state),
        onChime: () => browserIO.to(conversationId).emit('audio:chime'),
        onAudioChunk: (chunk) => browserIO.to(conversationId).emit('audio:chunk', chunk)
      }
    )
    engineSockets.set(conversationId, socket)
    pendingQueues.set(conversationId, queue)
  }

  browserIO.on('connection', (socket) => {
    const conversationId = socket.handshake.query.conversationId as string
    const botName = socket.handshake.query.botName as string
    const transcriptPasscode = socket.handshake.query.transcriptPasscode as string | undefined
    if (!conversationId || !botName) {
      socket.disconnect()
      return
    }

    socket.join(conversationId)

    // A reconnect (most commonly a page refresh) landing before the grace period below
    // elapsed — cancel the pending teardown so the existing engine socket/held audio, still
    // fully intact, gets reused instead of starting over from nothing.
    const pendingTeardown = teardownTimers.get(conversationId)
    if (pendingTeardown) {
      clearTimeout(pendingTeardown)
      teardownTimers.delete(conversationId)
      log(`${conversationId} reconnected within the grace period — resuming the existing session`)
    }

    if (!engineSockets.has(conversationId)) {
      createEngineSocketFor(conversationId, botName, { transcriptPasscode })
    } else if (pendingQueues.get(conversationId)?.hasPending()) {
      // A response is still held from before this connection existed (the reused-session case
      // above, or a second browser joining an already-active conversation) — without this, the
      // page starts assuming idle until the next real transition. A response already flushed to
      // a previous browser instance (state 'speaking') has no audio left to resync to, so only
      // hand-raised is worth replaying here.
      socket.emit('state', { state: 'hand-raised' })
    }

    // Browser signals when its audio queue is empty. If another response is still queued
    // behind the one that just finished, re-announce it (hand-raised + chime) instead of
    // going idle — otherwise a second question asked while the first was playing would sit
    // silently queued with no visual/audio cue that anything is still waiting for "go ahead".
    socket.on('audio:finished', () => {
      const queue = pendingQueues.get(conversationId)
      const stillQueued = queue?.hasPending() ?? false
      log(`${conversationId} audio finished${stillQueued ? ' — re-announcing what remains queued' : ' → idle'}`)
      queue?.audioFinished()
    })

    socket.on('disconnect', () => {
      const room = browserIO.sockets.adapter.rooms.get(conversationId)
      if (room && room.size > 0) return

      // Indistinguishable at this instant from the bot's browser leaving for good — wait to
      // see which one this actually is before tearing anything down. A refresh's reconnect
      // above cancels this; nothing arriving within the window means it really is done.
      log(`${conversationId} last client disconnected — waiting up to ${reconnectGraceMs}ms for a reconnect`)
      const timer = setTimeout(() => {
        teardownTimers.delete(conversationId)
        engineSockets.get(conversationId)?.disconnect()
        engineSockets.delete(conversationId)
        pendingQueues.delete(conversationId)
        // queue.reset()/idle is already triggered via the engine socket's own disconnect handler
        log(`${conversationId} no reconnect within the grace period, engine socket closed`)
      }, reconnectGraceMs)
      teardownTimers.set(conversationId, timer)
    })
  })

  // A temporary, self-removing listener — only for a synchronous bind failure (e.g.
  // EADDRINUSE) during startup, surfaced as a rejection instead of an unhandled 'error'
  // event. It's removed once listening succeeds so it never fires (and no-ops) for a later,
  // post-startup error; the caller (server.ts) attaches its own permanent handler for those.
  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error) => reject(err)
    httpServer.once('error', onListenError)
    httpServer.listen(config.port, () => {
      httpServer.removeListener('error', onListenError)
      resolve()
    })
  })

  return {
    httpServer,
    browserIO,
    async stop() {
      for (const timer of teardownTimers.values()) clearTimeout(timer)
      teardownTimers.clear()
      for (const socket of engineSockets.values()) socket.disconnect()
      engineSockets.clear()
      pendingQueues.clear()
      browserIO.close()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}
