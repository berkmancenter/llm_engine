// Deliberate: this, not typeRoots/normal resolution, is what makes kokoro-js's hand-written
// ambient types (see that file for why they're hand-written) actually reach ts-node/esm at
// real startup, not just tsc — see its own comment for the full story.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/kokoro-js.d.ts" />
import path from 'path'
import { fileURLToPath } from 'url'
import { env } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'

const __dir = path.dirname(fileURLToPath(import.meta.url))

// Apache-2.0, 82M params — see bot-media-server/README.md for how this compares to `say`.
const DEFAULT_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const DEFAULT_VOICE = 'af_heart'
const DEFAULT_DTYPE = 'q8'

export interface KokoroTtsOptions {
  /** One of kokoro-js's named voices (e.g. "af_heart", "am_adam") — see its own README for
   *  the full list, or call `tts.list_voices()` on a loaded instance. */
  voice?: string
  modelId?: string
  /** Where local model files are staged, and where any files kokoro-js does need to fetch get
   *  cached. Kept inside this package by default rather than @huggingface/transformers' own
   *  installed-package-relative default, so it's obvious where to pre-stage files for a
   *  network-free production deploy (see the README). */
  modelDir?: string
  /** 'q8' (the default) is the usual speed/quality/size sweet spot for CPU inference; see
   *  kokoro-js's own dtype options if you need to trade one for another. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'
  /** true allows reaching Hugging Face to fetch whatever isn't already in modelDir. Defaults
   *  to false: model files are expected to already be staged (see the README's manual-staging
   *  instructions) — deliberately no automatic download, after a corrupted first-run download
   *  once left a truncated model file that failed opaquely deep inside onnxruntime instead of
   *  with a clear error. */
  allowRemoteModels?: boolean
  /** Playback-speed multiplier passed through to kokoro-js on every call — 1 (the default) is
   *  normal speed, <1 slower, >1 faster. */
  speed?: number
}

/**
 * Loads the Kokoro model once and returns a ready-to-call text -> WAV Buffer function — the
 * same shape as say.ts's textToAudio, minus the per-call voice argument (Kokoro's voice is
 * fixed at load time here, the same way server.ts already binds SAY_VOICE once for say).
 * Returns raw bytes, not base64 — see say.ts's textToAudio for why.
 *
 * Loading happens here, eagerly, meant to be awaited by the caller before the server starts
 * accepting connections — not lazily on first use. The model is a few hundred MB and loading
 * it takes real time; better to pay that cost once at startup than as an unpredictable
 * latency spike on whichever chunk of whichever conversation happens to hit it first.
 */
export async function createKokoroTts(options: KokoroTtsOptions = {}): Promise<(text: string) => Promise<Buffer>> {
  const modelDir = options.modelDir ?? path.join(__dir, '..', 'models')
  // @huggingface/transformers' `env` is a module-level singleton, and kokoro-js imports that
  // same package — pinned in package.json to the exact range kokoro-js itself depends on, so
  // yarn hoists one shared copy — which is what makes mutating it here actually reach
  // kokoro-js's own model loader. kokoro-js's own exported `env` only proxies wasmPaths, not
  // the local-model settings this needs.
  env.localModelPath = modelDir
  env.cacheDir = modelDir
  env.allowRemoteModels = options.allowRemoteModels ?? false

  let tts
  try {
    tts = await KokoroTTS.from_pretrained(options.modelId ?? DEFAULT_MODEL_ID, {
      dtype: options.dtype ?? DEFAULT_DTYPE,
      device: 'cpu'
    })
  } catch (err) {
    throw new Error(
      `Kokoro model not found in ${modelDir} — see bot-media-server/README.md for how to stage it ` +
        `manually (or pass allowRemoteModels: true to fetch it automatically instead). Original error: ${err}`
    )
  }
  const voice = options.voice ?? DEFAULT_VOICE
  const speed = options.speed ?? 1

  return async function textToAudio(text: string): Promise<Buffer> {
    const audio = await tts.generate(text, { voice, speed })
    return Buffer.from(await audio.toBlob().arrayBuffer())
  }
}
