// kokoro-js ships types only via package.json's "exports" map (no top-level legacy "types"
// field), which this project's tsconfig can't see — it's on moduleResolution: "node"
// (classic), not "bundler"/"node16"/"nodenext". Rather than change that project-wide (it'd
// affect how every other import in the monorepo resolves), this is a minimal, hand-written
// declaration covering only what bot-media-server/tts/kokoro.ts actually uses. Cross-check
// against node_modules/kokoro-js/types/kokoro.d.ts if kokoro-js is ever upgraded and this
// stops matching.
//
// Kept local to bot-media-server/ rather than the project-root types/ (which is on
// tsconfig.json's typeRoots) so this stays self-contained to this package, with zero changes
// to shared config. That means it ISN'T auto-discovered by ts-node/esm (yarn bot-media-server's
// actual runtime) the way a typeRoots entry would be — tsc's own default whole-project scan
// picks it up regardless of location, so `yarn build` passing is not proof this works at real
// startup. kokoro.ts pulls it in explicitly via a triple-slash reference directive instead;
// don't remove that without another way to bring this file into ts-node's program.
declare module 'kokoro-js' {
  import type { RawAudio } from '@huggingface/transformers'

  export interface KokoroGenerateOptions {
    voice?: string
    speed?: number
  }

  export interface KokoroFromPretrainedOptions {
    dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'
    device?: 'wasm' | 'webgpu' | 'cpu' | null
  }

  export class KokoroTTS {
    static from_pretrained(model_id: string, options?: KokoroFromPretrainedOptions): Promise<KokoroTTS>

    generate(text: string, options?: KokoroGenerateOptions): Promise<RawAudio>

    list_voices(): string[]
  }
}
