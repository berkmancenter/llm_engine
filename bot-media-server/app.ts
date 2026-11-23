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
import { createEngineSocket, verifyChannelPasscode, AudioChunk } from './engineSocket.js'
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
  // How long 'thinking' may sit with no message:chunk before giving up — see
  // engineSocket.ts's THINKING_TIMEOUT_MS for the default and rationale. Overridable here so
  // tests don't have to wait for the real default.
  thinkingTimeoutMs?: number
  // How long a new browser connection's passcode check may take before it's treated as a
  // failure — see engineSocket.ts's verifyChannelPasscode. Overridable for the same reason as
  // thinkingTimeoutMs above.
  verifyPasscodeTimeoutMs?: number
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

  // Both real clients (the Recall camera page, NextSpace's iframe) load their own script from
  // this server, so they're same-origin and need no CORS exception. Leaving this wildcard open
  // only ever helped a client socket.io itself has no way to tell apart from an attacker's.
  const browserIO = new SocketIOServer(httpServer)

  // Tracked so a reconnecting browser (see 'connection' below) can be caught back up to
  // 'thinking' — unlike hand-raised, that state isn't reflected in the pending queue (nothing
  // is queued yet; the agent is still generating), so pendingQueues.hasPending() alone can't
  // tell a reconnecting browser it's mid-thought the way it already does for hand-raised.
  const lastStates = new Map<string, 'idle' | 'hand-raised' | 'thinking' | 'speaking'>()
  // The transcript line that triggered the most recent response (see engineSocket.ts's
  // onQuestion) — kept alongside lastStates so a reconnecting browser mid-'thinking'/
  // 'hand-raised' can be resynced with it too, not just the bare state.
  const lastQuestions = new Map<string, string>()
  // Learned once per conversation, the first time any browser's handshake passcode is verified
  // (see verifyChannelPasscode below) — whether the transcript channel actually has one
  // configured. false means there was nothing to check, so a verified connection there proves
  // nothing about who's asking; onQuestion below uses this to withhold the participant's actual
  // words from a conversation with no real secret to have gated them on, even though the
  // connection itself (state/audio, already broadcast openly before this) stays unchanged.
  const passcodeRequired = new Map<string, boolean>()

  function pushState(conversationId: string, state: 'idle' | 'hand-raised' | 'thinking' | 'speaking') {
    log(`${conversationId} state → ${state}`)
    lastStates.set(conversationId, state)
    browserIO.to(conversationId).emit('state', { state })
  }

  const engineSockets = new Map<string, Socket>()
  const pendingQueues = new Map<string, PendingQueue<AudioChunk>>()
  const teardownTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Browsers currently awaiting passcode verification, per conversation. They aren't in the
  // room yet, so an empty room alone doesn't mean nobody is about to be admitted.
  const verificationsInFlight = new Map<string, number>()

  function createEngineSocketFor(conversationId: string, botName: string, passcodes: { transcriptPasscode?: string } = {}) {
    const { socket, queue } = createEngineSocket(
      {
        llmEngineWsUrl: config.llmEngineWsUrl,
        conversationId,
        botName,
        transcriptPasscode: passcodes.transcriptPasscode,
        auth: config.auth,
        tts,
        onLog: log,
        thinkingTimeoutMs: config.thinkingTimeoutMs
      },
      {
        onStateChange: (state) => pushState(conversationId, state),
        onChime: () => browserIO.to(conversationId).emit('audio:chime'),
        onThinkingChime: () => browserIO.to(conversationId).emit('audio:chime:thinking'),
        onAudioChunk: (chunk) => browserIO.to(conversationId).emit('audio:chunk', chunk),
        onQuestion: (question) => {
          // Suppressed entirely for a conversation with no real passcode to have verified a
          // connection against — see passcodeRequired above. Never populating lastQuestions
          // here also keeps the reconnect-replay branches below from having anything to send.
          if (!passcodeRequired.get(conversationId)) return
          lastQuestions.set(conversationId, question)
          browserIO.to(conversationId).emit('question', { question })
        }
      }
    )
    engineSockets.set(conversationId, socket)
    pendingQueues.set(conversationId, queue)
  }

  function clearConversationState(conversationId: string) {
    engineSockets.get(conversationId)?.disconnect()
    engineSockets.delete(conversationId)
    pendingQueues.delete(conversationId)
    lastStates.delete(conversationId)
    lastQuestions.delete(conversationId)
    passcodeRequired.delete(conversationId)
  }

  // Tears down a conversation's engine socket/held state immediately rather than waiting out
  // reconnectGraceMs — only safe to call when the browserIO room is confirmed empty, since a
  // rejected connection (see 'connection' below) never reaches the normal 'disconnect' handler
  // that otherwise does this after a grace period.
  function teardownIfEmpty(conversationId: string) {
    // Other browsers mid-verification still need the session; the last one to finish re-runs this.
    if ((verificationsInFlight.get(conversationId) ?? 0) > 0) return
    const room = browserIO.sockets.adapter.rooms.get(conversationId)
    if (room && room.size > 0) return
    // A pending grace timer already owns this teardown (and a reconnect may still cancel it).
    if (teardownTimers.has(conversationId)) return
    clearConversationState(conversationId)
  }

  browserIO.on('connection', async (socket) => {
    const conversationId = socket.handshake.query.conversationId as string
    const botName = socket.handshake.query.botName as string
    const transcriptPasscode = socket.handshake.query.transcriptPasscode as string | undefined
    if (!conversationId || !botName) {
      socket.disconnect()
      return
    }

    // The engine socket must already exist to verify anything over it — but its existence
    // (a bare connection) carries no trust of its own; conversation:join's own channel-passcode
    // check (see createEngineSocketFor/engineSocket.ts's join()) only ever reflects whichever
    // passcode the FIRST browser for this conversation happened to send, not this one. Each
    // browser's own passcode is checked independently here, before it's ever added to the room
    // that receives state/audio/question — admitting it first and checking after would already
    // be too late.
    verificationsInFlight.set(conversationId, (verificationsInFlight.get(conversationId) ?? 0) + 1)
    let admitted = false
    try {
      admitted = await (async () => {
        if (!engineSockets.has(conversationId)) {
          createEngineSocketFor(conversationId, botName, { transcriptPasscode })
        }
        const engineSocket = engineSockets.get(conversationId)!

        const verification = await verifyChannelPasscode(
          engineSocket,
          config.auth,
          conversationId,
          'transcript',
          transcriptPasscode,
          config.verifyPasscodeTimeoutMs
        )
        if (!verification.ok) {
          log(`${conversationId} rejected an unauthenticated browser connection (${verification.reason ?? 'unknown'})`)
          socket.disconnect()
          return false
        }
        // The browser left while verification was in flight: its 'disconnect' already fired, before
        // the handler below was registered, so never join the dead socket.
        if (socket.disconnected) return false
        // Set even when already true for this conversation — cheap, and keeps this the single
        // place that ever writes it rather than requiring a has-it-been-set-yet check.
        passcodeRequired.set(conversationId, verification.passcodeRequired ?? false)

        socket.join(conversationId)
        return true
      })()
    } finally {
      const remaining = (verificationsInFlight.get(conversationId) ?? 1) - 1
      if (remaining > 0) verificationsInFlight.set(conversationId, remaining)
      else verificationsInFlight.delete(conversationId)
      // Covers a rejected or already-gone browser: nothing else will tear down for them.
      if (remaining === 0) teardownIfEmpty(conversationId)
    }
    if (!admitted) return
    // Verification is a real round trip to llm_engine, so a browser is no longer admitted to
    // the room in the same tick its transport connects, the way it was before this check
    // existed — a client (or test) that assumes otherwise and sends something immediately
    // after its own 'connect' can race ahead of this. This is the one honest signal that
    // admission actually finished; anything depending on order should wait for it instead of
    // inferring readiness from when its own socket opened.
    socket.emit('ready')

    // A reconnect (most commonly a page refresh) landing before the grace period below
    // elapsed — cancel the pending teardown so the existing engine socket/held audio, still
    // fully intact, gets reused instead of starting over from nothing.
    const pendingTeardown = teardownTimers.get(conversationId)
    if (pendingTeardown) {
      clearTimeout(pendingTeardown)
      teardownTimers.delete(conversationId)
      log(`${conversationId} reconnected within the grace period — resuming the existing session`)
    }

    // The engine socket itself (and so this conversation's pendingQueues/lastStates entries)
    // was already ensured above, before verification — nothing left to create here, just the
    // mid-response resync a second/reconnecting browser needs.
    if (pendingQueues.get(conversationId)?.hasPending()) {
      // A response is still held from before this connection existed (the reused-session case
      // above, or a second browser joining an already-active conversation) — without this, the
      // page starts assuming idle until the next real transition. A response already flushed to
      // a previous browser instance (state 'speaking') has no audio left to resync to, so only
      // hand-raised is worth replaying here.
      socket.emit('state', { state: 'hand-raised' })
      const question = lastQuestions.get(conversationId)
      if (question) socket.emit('question', { question })
    } else if (lastStates.get(conversationId) === 'thinking') {
      // Mid-generation, before anything reached the pending queue — the branch above can't see
      // this. Still worth replaying: like hand-raised, nothing time-sensitive to resync, just a
      // "still working on it" placeholder.
      socket.emit('state', { state: 'thinking' })
      const question = lastQuestions.get(conversationId)
      if (question) socket.emit('question', { question })
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
        clearConversationState(conversationId)
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
