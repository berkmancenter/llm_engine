/**
 * One llm_engine socket.io connection per active conversation — the "llm_engine protocol"
 * side of the bridge (conversation:join / message:chunk / message:new), independent of
 * however the browser side is implemented. Talks back only through `hooks`, not by reaching
 * into a socket.io server directly — see app.ts, which wires those hooks to browserIO. This
 * separation is what makes it unit-testable against a fake llm_engine socket.io server with
 * no real browserIO involved at all.
 */
import { io as connectSocketIO, Socket } from 'socket.io-client'
import { AuthManager } from './auth.js'
import { createPendingQueue, PendingQueue } from './pendingQueue.js'
import { isCalledUpon } from './callUpon.js'
import { computeAmplitudeEnvelope, ENVELOPE_WINDOW_MS } from './audioEnvelope.js'

/** One playable unit: the raw WAV bytes (not base64 — sent to the browser as a binary
 *  socket.io payload rather than a stringified one) plus a coarse amplitude envelope the
 *  browser uses to drive the mouth animation off real playback instead of a simulated
 *  babble. `envelope` is `[]` when it couldn't be computed (see message:chunk below) — the
 *  audio itself is never withheld just because the envelope failed. */
export interface AudioChunk {
  audio: Buffer
  envelope: number[]
  envelopeWindowMs: number
}

export interface EngineSocketHooks {
  onStateChange: (state: 'idle' | 'hand-raised' | 'speaking') => void
  onChime: () => void
  onAudioChunk: (chunk: AudioChunk) => void
}

export interface EngineSocketConfig {
  llmEngineWsUrl: string
  conversationId: string
  botName: string
  transcriptPasscode?: string
  auth: AuthManager
  tts: (text: string) => Promise<Buffer>
  onLog?: (message: string) => void
}

export interface EngineSocket {
  socket: Socket
  queue: PendingQueue<AudioChunk>
}

export function createEngineSocket(config: EngineSocketConfig, hooks: EngineSocketHooks): EngineSocket {
  const log = config.onLog ?? (() => {})
  const { conversationId, botName } = config

  const socket = connectSocketIO(config.llmEngineWsUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000
  })

  const queue = createPendingQueue<AudioChunk>({
    onAnnounce: () => {
      hooks.onStateChange('hand-raised')
      hooks.onChime()
    },
    onFlush: (chunks) => {
      hooks.onStateChange('speaking')
      for (const chunk of chunks) hooks.onAudioChunk(chunk)
    },
    onIdle: () => hooks.onStateChange('idle'),
    onDiscard: (requestId) => log(`${conversationId}/${requestId} TTL expired — discarding`)
  })

  // llm_engine's socket error handling (catchAsync) can't invoke this ack on failure — a
  // thrown error there (e.g. a wrong channel passcode) is only logged server-side on
  // llm_engine, never surfaced back here. So a join that silently never acks is itself the
  // symptom: if you don't see "joined conversation" within a few seconds, check llm_engine's
  // own logs for a channel/passcode error rather than assuming this process is broken.
  const JOIN_ACK_TIMEOUT_MS = 5_000

  const join = () => {
    const channels: { name: string; passcode?: string }[] = []
    if (config.transcriptPasscode) channels.push({ name: 'transcript', passcode: config.transcriptPasscode })
    log(
      `${conversationId} attempting conversation:join (channels: ${channels.map((c) => c.name).join(', ') || 'none'}${
        config.transcriptPasscode ? ', with transcript passcode' : ''
      })`
    )
    let acked = false
    socket.emit('conversation:join', { conversationId, token: config.auth.getAccessToken(), channels }, (ack: unknown) => {
      acked = true
      log(`${conversationId} joined conversation ${JSON.stringify(ack)}`)
    })
    setTimeout(() => {
      if (!acked) {
        log(
          `${conversationId} no join ack after ${JOIN_ACK_TIMEOUT_MS}ms — the join likely failed server-side ` +
            `(e.g. a wrong channel passcode). Check llm_engine's own logs, not this process's.`
        )
      }
    }, JOIN_ACK_TIMEOUT_MS)
  }

  socket.on('connect', () => {
    log(`${conversationId} connected to llm_engine`)
    join()
  })
  // 'reconnect' is a Manager-level event (fired once per successful automatic reconnection),
  // not a Socket-level one — socket.on('reconnect', ...) never fires, since the per-namespace
  // Socket only re-broadcasts 'connect'/'connect_error'/'disconnect'/'disconnecting' from its
  // Manager. Must be registered on socket.io (the Manager) to ever run.
  socket.io.on('reconnect', async () => {
    log(`${conversationId} reconnected — refreshing token`)
    await config.auth.refreshAccessToken()
    join()
  })
  socket.on('connect_error', (err) => {
    log(`${conversationId} connection error: ${err.message}`)
  })
  socket.on('disconnect', (reason) => {
    log(`${conversationId} disconnected: ${reason}`)
    queue.reset()
    hooks.onStateChange('idle')
  })

  socket.on('message:chunk', ({ requestId, text, done }: { requestId: string; text: string; done: boolean }) => {
    log(`${conversationId}/${requestId} received message:chunk (${text?.length ?? 0} chars, done: ${done})`)
    if (!done && text) {
      queue.startResponse(requestId)
      config
        .tts(text)
        .then((audio) => {
          // The envelope is an enhancement, not a requirement — a WAV neither engine is
          // actually expected to produce (or a future change to either) should never cost
          // the bot its voice for that chunk, just its lip-sync for it.
          let envelope: number[] = []
          try {
            envelope = computeAmplitudeEnvelope(audio)
          } catch (err) {
            log(`${conversationId}/${requestId} envelope computation failed, chunk will use no envelope: ${err}`)
          }
          queue.addAudio(requestId, { audio, envelope, envelopeWindowMs: ENVELOPE_WINDOW_MS })
        })
        .catch((err) => log(`${conversationId}/${requestId} TTS error: ${err}`))
    }
    if (done) queue.markResponseDone(requestId)
  })

  socket.on('message:new', ({ channels, body }: { channels?: string[]; body?: string }) => {
    if (!channels?.includes('transcript') || !body) return
    if (!queue.hasPending()) {
      log(`${conversationId} transcript message received, but nothing pending to call upon`)
      return
    }
    if (!isCalledUpon(body, botName)) {
      log(`${conversationId} transcript message received, but no call-upon phrase + "${botName}" match: "${body}"`)
      return
    }
    log(`${conversationId} call-upon matched — flushing held response`)
    queue.callUpon()
  })

  return { socket, queue }
}
