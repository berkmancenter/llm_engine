#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Bot media server for voiceAssistant.
 *
 * Serves an HTML page usable as a bot's audiovisual presence in a call — nothing
 * here is specific to Recall.ai; it's a generic page that drives a visual state
 * and speaks text aloud via TTS, suitable for any platform that can point a bot
 * at an arbitrary webpage for its camera+mic feed. Recall.ai is the current
 * consumer (see zoom.ts's output_media.camera config).
 *
 * One server process handles any number of simultaneous conversations. Each
 * bot gets a distinct URL:
 *
 *   https://your-server:3100?conversationId=<id>&botName=<name>&transcriptPasscode=<code>
 *
 * When the bot's headless browser loads that URL it connects to this server's
 * socket.io with the conversationId as a query param. The server opens one
 * llm_engine socket per active conversation and closes it when the last browser
 * for that conversation disconnects.
 *
 * The bot's visual presence is an animated character (see page.ts) and
 * it drives its own idle/hand-raised/speaking poses directly from `state` events.
 *
 *   &audio=false  (default: true)
 *     Skips the whole voice pipeline for a bot that should have a visual
 *     presence but never speaks: no socket.io connection to this server is
 *     opened at all, so no llm_engine socket is created and no
 *     message:chunk/message:new/transcript traffic is touched for that
 *     conversation. The character just stays idle, since nothing will ever
 *     emit a state change.
 *
 * State transitions (only relevant when audio is enabled) — see pendingQueue.ts
 * ─────────────────────────────────────────────────────────────────────────────
 *   message:chunk  done:false  → accumulate audio; chime on first chunk → hand-raised
 *   transcript message matches      → speaking (flush held audio)
 *   audio:finished (browser)        → re-announce (hand-raised) if another response is
 *                                      still queued, else idle
 *   call-upon TTL expires           → idle (if nothing else pending); held audio discarded
 *
 * Audio
 * ─────
 *   Each text chunk from message:chunk is converted to a WAV Buffer server-side (see tts/) and
 *   held in memory until the bot is called upon. On call-upon, chunks are sent to the browser
 *   as binary audio:chunk events. The browser queues and plays them in order. When the queue drains the
 *   browser emits audio:finished (see State transitions above).
 *
 *   TTS_ENGINE picks how that conversion happens (see tts/index.ts):
 *     kokoro (default) — an in-process neural TTS model (kokoro-js), loaded once at startup.
 *                          Works anywhere Node runs, including prod's Linux hosts.
 *     say                — shells out to macOS's `say`. Zero setup, but macOS-only; useful
 *                          for local dev on a Mac without pulling in a model.
 *
 * Auth — see auth.ts
 * ──────────────────
 *   The shared access token (used for every conversation:join) is refreshed proactively,
 *   scheduled off the real expires timestamp login/refresh-tokens returns — not a guessed
 *   or hardcoded lifetime — via the refresh token, falling back to a full login only if
 *   that's rejected. A failed refresh never crashes the process; it retries shortly instead,
 *   so a transient llm_engine outage can't take down every other conversation this process
 *   is holding open.
 *
 * Configuration (environment variables)
 * ──────────────────────────────────────
 *   LLM_ENGINE_URL         llm_engine HTTP base URL                 (default: http://localhost:3000/v1)
 *   LLM_ENGINE_WS_URL      llm_engine websocket base URL     (default: ws://localhost:5555)
 *   LLM_ENGINE_USERNAME    llm_engine account username       (required)
 *   LLM_ENGINE_PASSWORD    llm_engine account password       (required)
 *   TTS_ENGINE              "kokoro" or "say"                  (default: kokoro)
 *   SAY_VOICE               macOS `say -v` voice name          (optional, system default; TTS_ENGINE=say only)
 *   KOKORO_VOICE             a kokoro-js voice name, e.g. "af_heart"  (optional, kokoro's own default otherwise; TTS_ENGINE=kokoro only)
 *   KOKORO_MODEL_DIR         where Kokoro's model files must already be staged by default —
 *                            see KOKORO_ALLOW_REMOTE_MODELS below to download instead
 *                            (optional, defaults to bot-media-server/models; see README's
 *                            "Staging the Kokoro model"; TTS_ENGINE=kokoro only)
 *   KOKORO_SPEED             playback-speed multiplier, e.g. "1.15"  (optional, default 1; TTS_ENGINE=kokoro only)
 *   KOKORO_ALLOW_REMOTE_MODELS  "true" to download missing model files on demand instead of
 *                            requiring them staged ahead of time  (optional, default false;
 *                            recommended for local dev only — see the README; TTS_ENGINE=kokoro only)
 *   PORT                   HTTP port for this server          (default: 3100)
 *
 * Files
 * ─────
 *   auth.ts          token login/refresh
 *   callUpon.ts       "go ahead <botName>"-style phrase matching
 *   pendingQueue.ts   held-audio/call-upon state machine (per conversation)
 *   tts/              text -> WAV Buffer; say.ts (macOS `say`), kokoro.ts (in-process
 *                     neural TTS), index.ts (picks one per TTS_ENGINE)
 *   page.ts           the HTML/JS page served to the bot's browser
 *   app.ts            the composed app (HTTP + socket.io wiring), exported for tests
 *   server.ts         this file — CLI entrypoint: env vars, login, starts app.ts
 *
 * Usage:
 *   node --loader ts-node/esm bot-media-server/server.ts
 */

import { config as loadEnv } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { createAuthManager, describeError } from './auth.js'
import { startBotMediaApp } from './app.js'
import { createTts } from './tts/index.js'

const __dir = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.join(__dir, '.env') })

const {
  LLM_ENGINE_URL = 'http://localhost:3000/v1',
  LLM_ENGINE_WS_URL = 'ws://localhost:5555',
  LLM_ENGINE_USERNAME,
  LLM_ENGINE_PASSWORD,
  TTS_ENGINE = 'kokoro',
  SAY_VOICE,
  KOKORO_VOICE,
  KOKORO_MODEL_DIR,
  KOKORO_SPEED,
  KOKORO_ALLOW_REMOTE_MODELS,
  PORT = '3100'
} = process.env

if (!LLM_ENGINE_USERNAME) {
  console.error('LLM_ENGINE_USERNAME is required')
  process.exit(1)
}
if (!LLM_ENGINE_PASSWORD) {
  console.error('LLM_ENGINE_PASSWORD is required')
  process.exit(1)
}
if (TTS_ENGINE !== 'say' && TTS_ENGINE !== 'kokoro') {
  console.error(`TTS_ENGINE must be "say" or "kokoro" (got "${TTS_ENGINE}")`)
  process.exit(1)
}
const kokoroSpeed = KOKORO_SPEED === undefined ? undefined : Number(KOKORO_SPEED)
if (kokoroSpeed !== undefined && !Number.isFinite(kokoroSpeed)) {
  console.error(`KOKORO_SPEED must be a number (got "${KOKORO_SPEED}")`)
  process.exit(1)
}
if (
  KOKORO_ALLOW_REMOTE_MODELS !== undefined &&
  KOKORO_ALLOW_REMOTE_MODELS !== 'true' &&
  KOKORO_ALLOW_REMOTE_MODELS !== 'false'
) {
  console.error(`KOKORO_ALLOW_REMOTE_MODELS must be "true" or "false" (got "${KOKORO_ALLOW_REMOTE_MODELS}")`)
  process.exit(1)
}
const kokoroAllowRemoteModels = KOKORO_ALLOW_REMOTE_MODELS === undefined ? undefined : KOKORO_ALLOW_REMOTE_MODELS === 'true'
if (kokoroAllowRemoteModels) {
  console.warn(
    '[bot-media-server] KOKORO_ALLOW_REMOTE_MODELS=true — missing model files will be downloaded ' +
      'automatically. Recommended for local dev only, not production: an interrupted download can leave a ' +
      'corrupted model file that fails opaquely later (see tts/kokoro.ts and the README\'s "Staging the ' +
      'Kokoro model" section).'
  )
}

const auth = createAuthManager({
  llmEngineUrl: LLM_ENGINE_URL,
  username: LLM_ENGINE_USERNAME,
  password: LLM_ENGINE_PASSWORD,
  onLog: (msg) => console.log(`[bot-media-server] ${msg}`),
  onWarn: (msg) => console.warn(`[bot-media-server] ${msg}`),
  onError: (msg) => console.error(`[bot-media-server] ${msg}`)
})

try {
  await auth.login()
} catch (err) {
  console.error(`[bot-media-server] initial login failed: ${describeError(err)}`)
  process.exit(1)
}

// Built eagerly, awaited here rather than left to load lazily on the first chunk of the
// first conversation: kokoro's model load takes real time, and a bad TTS_ENGINE/model
// config should fail startup loudly, the same way a bad login does above, not surface as a
// mysterious failure partway through someone's meeting.
let tts
try {
  tts = await createTts({
    engine: TTS_ENGINE,
    voice: TTS_ENGINE === 'say' ? SAY_VOICE : KOKORO_VOICE,
    kokoro: { modelDir: KOKORO_MODEL_DIR, speed: kokoroSpeed, allowRemoteModels: kokoroAllowRemoteModels }
  })
} catch (err) {
  console.error(`[bot-media-server] failed to initialize TTS_ENGINE "${TTS_ENGINE}":`, err)
  process.exit(1)
}

let app
try {
  app = await startBotMediaApp({
    llmEngineWsUrl: LLM_ENGINE_WS_URL,
    port: parseInt(PORT, 10),
    auth,
    tts,
    onLog: (msg) => console.log(`[bot-media-server] ${msg}`)
  })
} catch (err) {
  console.error('[bot-media-server] failed to start:', err)
  process.exit(1)
}

// http.Server is an EventEmitter — an unhandled 'error' event (e.g. EADDRINUSE if the
// port is already taken) throws and crashes the process with no useful message otherwise.
// startBotMediaApp already surfaces a startup-time bind failure as a rejection (caught
// above); this covers any error after that point, for the life of the process.
app.httpServer.on('error', (err) => {
  console.error('[bot-media-server] HTTP server error:', err)
  process.exit(1)
})

const address = app.httpServer.address()
const actualPort = typeof address === 'object' && address ? address.port : PORT
console.log(`[bot-media-server] serving on http://localhost:${actualPort}`)
console.log(`[bot-media-server] llm_engine: ${LLM_ENGINE_WS_URL}`)
