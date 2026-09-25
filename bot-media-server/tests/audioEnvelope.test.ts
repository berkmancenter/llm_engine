import { computeAmplitudeEnvelope, ENVELOPE_WINDOW_MS } from '../audioEnvelope.js'
import buildTestWav, { buildTestWavFloat32 } from './wavTestHelper.js'

describe('computeAmplitudeEnvelope', () => {
  it('returns near-zero for silence', () => {
    const wav = buildTestWav(new Array(800).fill(0), 8000)
    const envelope = computeAmplitudeEnvelope(wav)
    expect(envelope.every((v) => v === 0)).toBe(true)
  })

  it('returns near-1 for a full-scale constant signal', () => {
    const wav = buildTestWav(new Array(800).fill(32767), 8000)
    const envelope = computeAmplitudeEnvelope(wav)
    expect(envelope.every((v) => v > 0.99 && v <= 1)).toBe(true)
  })

  it('treats a negative-amplitude signal the same as a positive one (RMS, not raw value)', () => {
    const wav = buildTestWav(new Array(800).fill(-32768), 8000)
    const envelope = computeAmplitudeEnvelope(wav)
    expect(envelope.every((v) => v > 0.99 && v <= 1)).toBe(true)
  })

  it('produces one window per ENVELOPE_WINDOW_MS of audio, by default', () => {
    // 8000Hz, 1 second of audio -> 8000 samples -> 1000 / ENVELOPE_WINDOW_MS windows
    const sampleRate = 8000
    const samples = new Array(sampleRate).fill(1000)
    const wav = buildTestWav(samples, sampleRate)

    const envelope = computeAmplitudeEnvelope(wav)

    const expectedWindows = Math.ceil(1000 / ENVELOPE_WINDOW_MS)
    expect(envelope).toHaveLength(expectedWindows)
  })

  it('honors a custom window size', () => {
    const sampleRate = 8000
    const samples = new Array(sampleRate).fill(1000) // 1 second
    const wav = buildTestWav(samples, sampleRate)

    const envelope = computeAmplitudeEnvelope(wav, 100)

    expect(envelope).toHaveLength(10) // 1000ms / 100ms
  })

  it('produces higher values for louder windows than quieter ones', () => {
    const sampleRate = 8000
    const quiet = new Array(800).fill(1000)
    const loud = new Array(800).fill(30000)
    const wav = buildTestWav([...quiet, ...loud], sampleRate)

    // 800 samples @ 8000Hz = 100ms per half; use a window size that lines up with that split.
    const envelope = computeAmplitudeEnvelope(wav, 100)

    expect(envelope[0]).toBeLessThan(envelope[envelope.length - 1])
  })

  it('rescales a chunk whose loudest moment is well below full scale so it still reads as fully open', () => {
    // ~6000 is about 18% of int16 full scale — in the ballpark of real speech RMS (say.ts and
    // kokoro.ts both measured around 0.15-0.21 on real output), which is exactly the case that
    // used to leave the mouth looking barely-open: without per-chunk peak rescaling this would
    // come back as ~0.18, not ~1.
    const wav = buildTestWav(new Array(800).fill(6000), 8000)
    const envelope = computeAmplitudeEnvelope(wav)
    expect(envelope.every((v) => v > 0.99 && v <= 1)).toBe(true)
  })

  it('does not amplify a near-silent chunk into a wide-open mouth', () => {
    // A tiny amount of noise floor, not real signal — should stay quiet, not get rescaled up
    // to 1 just because it's technically the loudest thing in an otherwise-silent chunk.
    const wav = buildTestWav(new Array(800).fill(50), 8000) // ~0.0015 of full scale
    const envelope = computeAmplitudeEnvelope(wav)
    expect(envelope.every((v) => v < 0.01)).toBe(true)
  })

  it('throws for anything that is not a RIFF/WAVE buffer', () => {
    expect(() => computeAmplitudeEnvelope(Buffer.from('not a wav file at all'))).toThrow(/RIFF\/WAVE/)
  })

  it('throws for an unsupported sample format instead of silently returning a meaningless envelope', () => {
    const wav = buildTestWav([1, 2, 3], 8000)
    wav.writeUInt16LE(8, 34) // corrupt the bitsPerSample field to 8-bit (still audioFormat 1)
    expect(() => computeAmplitudeEnvelope(wav)).toThrow(/audioFormat=1, 8-bit/)
  })

  // kokoro.ts actually produces 32-bit float PCM, not 16-bit integer PCM like say.ts — this
  // is what would have silently fallen back to no envelope (and did, before this was caught
  // by testing against real kokoro-js output) if only the 16-bit path were supported.
  describe('32-bit float PCM (kokoro.ts)', () => {
    it('returns near-zero for silence', () => {
      const wav = buildTestWavFloat32(new Array(800).fill(0), 24000)
      const envelope = computeAmplitudeEnvelope(wav)
      expect(envelope.every((v) => v === 0)).toBe(true)
    })

    it('returns near-1 for a full-scale constant signal', () => {
      const wav = buildTestWavFloat32(new Array(800).fill(1), 24000)
      const envelope = computeAmplitudeEnvelope(wav)
      expect(envelope.every((v) => v > 0.99 && v <= 1)).toBe(true)
    })

    it('produces higher values for louder windows than quieter ones', () => {
      const sampleRate = 24000
      const quiet = new Array(2400).fill(0.05)
      const loud = new Array(2400).fill(0.9)
      const wav = buildTestWavFloat32([...quiet, ...loud], sampleRate)

      // 2400 samples @ 24000Hz = 100ms per half.
      const envelope = computeAmplitudeEnvelope(wav, 100)

      expect(envelope[0]).toBeLessThan(envelope[envelope.length - 1])
    })
  })
})
