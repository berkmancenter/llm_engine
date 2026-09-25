# bot-media-server

A standalone service that gives a meeting bot a camera+mic presence: a browser page that
renders an animated character (idle / hand-raised / speaking) and speaks llm_engine's
responses aloud via TTS. It's not specific to any one platform — anything that can point a
bot at an arbitrary webpage for its camera+mic feed can use it. Recall.ai's
`output_media.camera` (see `src/adapters/zoom.ts`) is the current consumer.

One process serves any number of simultaneous conversations at once, each on its own URL.

See the top-of-file comment in [`server.ts`](./server.ts) for the full design (state
transitions, audio pipeline, auth refresh strategy). This README is about running it.

## Requirements

- Node 20/22, same as the rest of llm_engine
- **llm_engine already running before you start this** — `server.ts` logs in at startup
  (`auth.login()`) before it does anything else, so if llm_engine isn't reachable yet,
  bot-media-server fails immediately with a login error instead of starting. There's no
  retry-until-ready here; start llm_engine first, then this.
- A **llm_engine account for this bot to log in as** — add it to llm_engine's own
  `SYSTEM_USERS` env var (see the root `.env.example`), e.g.:
  ```
  SYSTEM_USERS=output-media-bot::s0mepassword
  ```
- On the default `TTS_ENGINE=kokoro`, the Kokoro model files staged at `KOKORO_MODEL_DIR`
  (see [Staging the Kokoro model](#staging-the-kokoro-model) below) — by default there's no
  automatic download at startup; `KOKORO_ALLOW_REMOTE_MODELS=true` turns that back on, dev-only.

## Text-to-speech engines

[`tts/`](./tts) has two interchangeable engines, picked by `TTS_ENGINE`:

- **`kokoro`** (default) — [kokoro-js](https://www.npmjs.com/package/kokoro-js), an
  in-process neural TTS model. Works anywhere Node runs, including prod's Linux hosts. The
  model (a few hundred MB) loads once at startup — see [`tts/kokoro.ts`](./tts/kokoro.ts) —
  not lazily on first use, so a bad `TTS_ENGINE`/model config fails startup loudly instead of
  surfacing mid-meeting. `KOKORO_VOICE` picks a voice (see kokoro-js's README for the full
  list, or [Kokoro's own VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)
  for per-voice quality grades); `KOKORO_SPEED` is a playback-speed multiplier (default `1`,
  e.g. `1.15` for slightly faster); `KOKORO_MODEL_DIR` picks where model files are staged
  (defaults to `bot-media-server/models/`). **No automatic download by default** — see
  [Staging the Kokoro model](#staging-the-kokoro-model) below (including the dev-only
  `KOKORO_ALLOW_REMOTE_MODELS` opt-out); startup fails with a clear error naming the missing
  file if nothing's staged and downloading isn't enabled.
- **`say`** — shells out to macOS's `say` command. Zero setup (no model to download), but
  **macOS-only** — this service can't speak with `TTS_ENGINE=say` on Linux/Windows. Handy for
  quick local dev on a Mac without pulling in a model. `SAY_VOICE` picks a `say -v` voice.

Both engines share the same `(text) => Promise<Buffer>` contract ([`tts/index.ts`](./tts/index.ts)
picks one at startup), so nothing else in this package — `page.ts`, `client.js`, `app.ts` —
knows or cares which engine is actually running. That `Buffer` is raw WAV bytes, not base64:
it's sent on to the browser as a binary `audio:chunk` socket.io payload (socket.io sends
`Buffer`s as binary WebSocket frames natively) rather than a stringified one, which avoids
paying to base64-encode it server-side and decode it again client-side for no benefit.

## Staging the Kokoro model

`TTS_ENGINE=kokoro` needs these files present under `KOKORO_MODEL_DIR` (default
`bot-media-server/models/`) before startup — by default there's deliberately no automatic
download (an interrupted first-run download once left a truncated model file that failed
opaquely deep inside `onnxruntime` instead of with a clear error; see
`KOKORO_ALLOW_REMOTE_MODELS` below if you want that convenience back for local dev):

```
bot-media-server/models/onnx-community/Kokoro-82M-v1.0-ONNX/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    └── model_quantized.onnx   ← the file for dtype "q8" (the default)
```

The `onnx/` filename depends on dtype — the model repo ships one file per quantization level:

| dtype          | file                   | size    |
| -------------- | ---------------------- | ------- |
| `fp32`         | `model.onnx`           | 326 MB  |
| `fp16`         | `model_fp16.onnx`      | 163 MB  |
| `q8` (default) | `model_quantized.onnx` | 92.4 MB |
| `q4`           | `model_q4.onnx`        | 305 MB  |
| `q4f16`        | `model_q4f16.onnx`     | 155 MB  |

**Option 1 — `huggingface-cli` (recommended: resumable, verifies what it downloads):**

```bash
pip install -U "huggingface_hub[cli]"
huggingface-cli download onnx-community/Kokoro-82M-v1.0-ONNX \
  config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx \
  --local-dir bot-media-server/models/onnx-community/Kokoro-82M-v1.0-ONNX
```

**Option 2 — plain `curl`, no Python needed (verify the size yourself afterward):**

```bash
MODEL_DIR="bot-media-server/models/onnx-community/Kokoro-82M-v1.0-ONNX"
BASE="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"
mkdir -p "$MODEL_DIR/onnx"
for f in config.json tokenizer.json tokenizer_config.json onnx/model_quantized.onnx; do
  curl -fL -o "$MODEL_DIR/$f" "$BASE/$f"
done
ls -la "$MODEL_DIR/onnx/model_quantized.onnx"   # should read 92,361,116 bytes
```

If you stage it anywhere other than the default, point `KOKORO_MODEL_DIR` at that path. A
missing or incomplete file fails startup with a clear error naming the exact path it looked
for (see `tts/kokoro.ts`) — if you ever see a `Protobuf parsing failed` error from
`onnxruntime` instead, that means a file _is_ present but corrupt/truncated; delete
`KOKORO_MODEL_DIR` and re-stage rather than trying to patch it.

**`KOKORO_ALLOW_REMOTE_MODELS=true`** restores the automatic-download behavior for whatever's
missing, if you'd rather have that — **recommended for local dev only, not production.** It's
the exact behavior that caused the corrupted-model failure mode above in the first place: a
network hiccup mid-download leaves a truncated file behind with nothing to catch it. Setting
it logs a startup warning as a reminder. Production should always have the model pre-staged
(above) instead.

## Setup

```bash
cp bot-media-server/.env.example bot-media-server/.env
# fill in LLM_ENGINE_USERNAME / LLM_ENGINE_PASSWORD to match the SYSTEM_USERS entry above
yarn bot-media-server
```

Defaults to `http://localhost:3100`. See [`.env.example`](./.env.example) for every variable
(`LLM_ENGINE_URL`, `LLM_ENGINE_WS_URL`, `TTS_ENGINE`, `SAY_VOICE`, `KOKORO_VOICE`,
`KOKORO_SPEED`, `KOKORO_MODEL_DIR`, `KOKORO_ALLOW_REMOTE_MODELS`, `PORT`).

## URL format

```
http://localhost:3100?conversationId=<id>&botName=<name>&transcriptPasscode=<code>&audio=false
```

| Param                | Required         | Purpose                                                                         |
| -------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `conversationId`     | if audio enabled | The llm_engine conversation this bot's socket joins                             |
| `botName`            | if audio enabled | Used for "go ahead `<botName>`"-style call-upon matching (see `callUpon.ts`)    |
| `transcriptPasscode` | no               | Passcode for the conversation's transcript channel, if it has one               |
| `audio`              | no               | `false` disables the whole voice pipeline — no socket, no TTS. Default: `true`. |

With `audio=false` the character still runs, just always idle (nothing will ever move it to
hand-raised/speaking, since no `state` events are ever sent to a page that never connects).

## Tests

```bash
yarn test:bot-media-server
```

Runs just `bot-media-server/tests/**` (unit tests for `auth.ts`, `pendingQueue.ts`,
`callUpon.ts`, `client.js`, `engineSocket.ts`, `tts/index.ts`, `tts/kokoro.ts` — the last via
a mocked `kokoro-js`/`@huggingface/transformers`, no real model load — plus an `app.test.ts`
integration test that exercises the full round trip against a fake llm_engine socket.io
server). Same Jest config as the main suite, so `yarn test` also covers it.

## Manual testing in Chrome

**Visual only** — good for iterating on the character animation (`page.ts`) without standing anything else up:

1. `yarn bot-media-server` (still needs a valid llm_engine login to start, per Requirements
   above, even though this particular check never opens a socket — and on the default
   `TTS_ENGINE=kokoro`, the model needs to already be staged; see Requirements)
2. Open `http://localhost:3100/?audio=false`
3. You should see the character idling (periwinkle background, slow breathing, occasional
   blink) on a plain 16:9 tile — this is exactly what the bot's camera feed looks like.

**Full check, with real state transitions and audio** — needs both llm_engine and
bot-media-server running, and a real conversation with voice output enabled:

1. Start llm_engine (`yarn dev` or similar) and note an active conversation's id.
2. Start `yarn bot-media-server` here.
3. Open `http://localhost:3100/?conversationId=<id>&botName=<name>` in Chrome — omit
   `transcriptPasscode` unless that conversation's transcript channel has one.
4. **Chrome will block the TTS audio from playing** — a page that was never clicked has no
   user gesture, and Chrome's autoplay policy silently drops `<audio>.play()` calls in that
   case (this is a Chrome behavior, not a bug in `client.js`). To hear it:
   - Click anywhere on the page once before the bot is expected to speak — one click
     satisfies Chrome's autoplay policy for the rest of that tab's session, or
   - For a page you'll reload a lot while iterating, make it permanent instead: click the
     tune/lock icon left of the address bar → **Site settings** → **Sound** → **Allow** (or
     visit `chrome://settings/content/sound` and add `localhost:3100` to "Allowed to send
     sound"). Recall.ai's own embedded browser isn't subject to this at all — it launches
     Chromium with autoplay unrestricted, so this step is purely a manual-testing concern.
5. Trigger a spoken response using [Hoppscotch](https://hoppscotch.io/) (or curl/Postman/any
   API client) to post directly into the conversation's `transcript` channel — this is the
   same path a real Zoom transcript line takes:

   1. Log in as a participant/admin on that conversation to get a token:
      `POST {LLM_ENGINE_URL}/auth/login` with `{ "username": "...", "password": "..." }` —
      copy `tokens.access.token` from the response.
   2. Address the bot by name so the agent actually generates a response (this is what
      raises the hand and chimes — the response is held, not spoken yet):
      `POST {LLM_ENGINE_URL}/messages`, `Authorization: Bearer <token>`, body:
      ```json
      {
        "conversation": "<conversationId>",
        "body": "hey <botName>, what's this event about?",
        "channels": [{ "name": "transcript", "passcode": "<transcriptPasscode if any>" }]
      }
      ```
   3. Once you see the chime/hand-raise, release it with the actual call-upon phrase
      `callUpon.ts` listens for (see `CALL_UPON_PHRASES`) — same endpoint, same channel:
      `"body": "go ahead <botName>"`. The character should switch to its speaking pose and
      you should hear the response; it goes idle again once the audio queue drains.

   A bare `"hey <botName>"` on its own won't move the character — it only prompts the agent
   to generate a response; the character stays in hand-raised until a recognized call-upon
   phrase (like `"go ahead <botName>"`) actually releases it. There has to be something
   pending for step 3 to have anything to flush, so don't skip step 2.
