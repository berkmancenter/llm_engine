import sayTextToAudio from './say.js'
import { createKokoroTts, KokoroTtsOptions } from './kokoro.js'

export type TtsEngine = 'say' | 'kokoro'

export interface CreateTtsOptions {
  engine?: TtsEngine
  /** say: a `say -v` voice name (system default if omitted). kokoro: one of kokoro-js's
   *  named voices, e.g. "af_heart" (kokoro's own default if omitted). */
  voice?: string
  /** Engine-specific tuning, only consulted when engine is 'kokoro'. */
  kokoro?: Omit<KokoroTtsOptions, 'voice'>
}

export interface TtsDeps {
  say: typeof sayTextToAudio
  createKokoroTts: typeof createKokoroTts
}
const defaultDeps: TtsDeps = { say: sayTextToAudio, createKokoroTts }

/**
 * Builds the (text) => Promise<WAV Buffer> function bot-media-server actually calls per
 * chunk, for whichever engine is configured. Raw bytes, not base64 — see say.ts's textToAudio
 * for why (callers send it on as a binary payload, not a string).
 *
 * Kept as two separate modules (say.ts, kokoro.ts) rather than one file with a branch inside:
 * say.ts needs macOS and nothing else; kokoro.ts needs neither macOS nor a subprocess, but
 * does need an async model load up front. A caller that only wants one of them (a test, or a
 * deployment that will only ever use one engine) can import that module directly without
 * pulling in the other's setup at all.
 */
export async function createTts(
  options: CreateTtsOptions = {},
  deps: TtsDeps = defaultDeps
): Promise<(text: string) => Promise<Buffer>> {
  const engine = options.engine ?? 'kokoro'
  if (engine === 'say') {
    return (text: string) => deps.say(text, options.voice)
  }
  return deps.createKokoroTts({ ...options.kokoro, voice: options.voice })
}
