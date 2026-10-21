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
  onStateChange: (state: 'idle' | 'hand-raised' | 'thinking' | 'speaking') => void
  onChime: () => void
  onThinkingChime: () => void
  onAudioChunk: (chunk: AudioChunk) => void
}

// How long 'thinking' is allowed to sit with no message:chunk before giving up and going back
// to idle — covers an LLM call that errors or times out. A tool-using agent's LLM call has been observed taking a couple of minutes, so
// this is set well above that — the cost of guessing too short is a visible "never mind" blip
// while the agent is still legitimately working, which is worse than a rare, genuine hang
// sitting in 'thinking' a bit longer than it has to.
export const THINKING_TIMEOUT_MS = 5 * 60_000

export interface EngineSocketConfig {
  llmEngineWsUrl: string
  conversationId: string
  botName: string
  transcriptPasscode?: string
  auth: AuthManager
  tts: (text: string) => Promise<Buffer>
  onLog?: (message: string) => void
  // Overridable so tests don't have to wait THINKING_TIMEOUT_MS for real.
  thinkingTimeoutMs?: number
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

  // Cleared the moment a real chunk shows up (see message:chunk below) — only ever fires if
  // 'thinking' was entered and genuinely nothing followed it.
  let thinkingTimeout: ReturnType<typeof setTimeout> | undefined

  // Tracked locally (rather than asking the queue) so agent:responding below can tell whether
  // it's safe to show 'thinking' — see there for why.
  let currentState: 'idle' | 'hand-raised' | 'thinking' | 'speaking' = 'idle'
  function setState(state: typeof currentState) {
    currentState = state
    hooks.onStateChange(state)
  }

  const queue = createPendingQueue<AudioChunk>({
    onAnnounce: () => {
      setState('hand-raised')
      hooks.onChime()
    },
    onFlush: (chunks) => {
      setState('speaking')
      for (const chunk of chunks) hooks.onAudioChunk(chunk)
    },
    // Already speaking by the time this chunk's TTS finished (no new state change needed) —
    // this is what makes it safe to call upon a response before every chunk has converted.
    onChunkReady: (chunk) => hooks.onAudioChunk(chunk),
    onIdle: () => setState('idle'),
    onDiscard: (requestId) => log(`${conversationId}/${requestId} TTL expired — discarding`)
  })

  // llm_engine's socket error handling (catchAsync) can't invoke this ack on failure — a
  // thrown error there (e.g. a wrong channel passcode) is only logged server-side on
  // llm_engine, never surfaced back here. So a join that silently never acks is itself the
  // symptom: if you don't see "joined conversation" within a few seconds, check llm_engine's
  // own logs for a channel/passcode error rather than assuming this process is broken.
  const JOIN_ACK_TIMEOUT_MS = 5_000

  const join = () => {
    // Always join the transcript channel's own socket.io room, passcode or not — llm_engine
    // only routes message:chunk/message:new to a channel's room (`${conversationId}_transcript`)
    // for sockets that explicitly joined it, regardless of whether that channel actually
    // requires a passcode (channel.model.ts documents `passcode: null` as a supported way to
    // disable one). Omitting this channel whenever no passcode happens to be configured used
    // to mean silently never receiving anything — no chime, no speaking, no error anywhere.
    const channels: { name: string; passcode?: string }[] = [
      { name: 'transcript', ...(config.transcriptPasscode && { passcode: config.transcriptPasscode }) }
    ]
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
    clearTimeout(thinkingTimeout)
    queue.reset()
    setState('idle')
  })

  socket.on('message:chunk', ({ requestId, text, done }: { requestId: string; text: string; done: boolean }) => {
    log(`${conversationId}/${requestId} received message:chunk (${text?.length ?? 0} chars, done: ${done})`)
    if (!done && text) {
      // A real chunk arrived — 'thinking' was correct, not abandoned.
      clearTimeout(thinkingTimeout)
      queue.startResponse(requestId)
      // Registered synchronously, before the async conversion below — so the queue knows to
      // keep waiting for this chunk even if a call-upon phrase flushes the response before
      // TTS for it finishes (a longer chunk can easily take longer to convert than it takes
      // someone to say "go ahead").
      queue.expectChunk(requestId)
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
        .catch((err) => {
          log(`${conversationId}/${requestId} TTS error: ${err}`)
          // Still counts against expectChunk even though nothing will ever be delivered for
          // it — otherwise one failed chunk would permanently stop this response from ever
          // being considered fully delivered.
          queue.chunkFailed(requestId)
        })
    }
    if (done) {
      queue.markResponseDone(requestId)
      // A done:true with no preceding real chunk (text was always empty/falsy, so the branch
      // above never ran queue.startResponse for this requestId) means nothing was ever
      // registered for this response — answerQuestion threw/returned nothing, or there was no
      // transcript channel to stream onto at all (see voiceAssistant.ts's respond()).
      if (currentState === 'thinking' && !queue.hasPending()) {
        clearTimeout(thinkingTimeout)
        setState('idle')
      }
    }
  })

  // llm_engine's generic "an agent is working on a response" signal (see
  // src/websockets/websocketGateway.ts's broadcastAgentResponding) — fires well before
  // message:chunk, as soon as an agent commits to answering. hand-raised is a separate,
  // later moment (a moderator's live "go ahead" flushing the held response via call-upon), so
  // this only ever moves the state to 'thinking', never ahead of where call-upon/flush already
  // took it.
  socket.on('agent:responding', () => {
    // Only meaningful from idle. A second question can trigger its own respond() call (and
    // its own agent:responding) while the first response is still hand-raised or speaking —
    // pendingQueue happily queues that up, but visually dropping back to 'thinking' would
    // wrongly interrupt whatever's currently showing (and chime over audio still playing).
    // The queued response still gets its own hand-raised announcement once it reaches the
    // front of the queue with audio ready — it just skips the 'thinking' cue for itself.
    if (currentState !== 'idle') {
      log(`${conversationId} agent:responding received while already ${currentState} — ignoring`)
      return
    }
    log(`${conversationId} agent:responding — thinking`)
    setState('thinking')
    hooks.onThinkingChime()
    clearTimeout(thinkingTimeout)
    thinkingTimeout = setTimeout(() => {
      log(
        `${conversationId} no message:chunk within ${
          config.thinkingTimeoutMs ?? THINKING_TIMEOUT_MS
        }ms of agent:responding — giving up, back to idle`
      )
      setState('idle')
    }, config.thinkingTimeoutMs ?? THINKING_TIMEOUT_MS)
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
    if (queue.callUpon()) {
      log(`${conversationId} call-upon matched — flushing held response`)
    } else {
      log(`${conversationId} call-upon matched, but already speaking — ignoring`)
    }
  })

  return { socket, queue }
}
