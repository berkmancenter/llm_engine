/**
 * Computes a coarse amplitude envelope from a WAV buffer, so the bot's mouth animation can
 * track the actual speech instead of a generic simulated babble — see page.ts, which reads
 * this back keyed to real playback position (Audio.currentTime), not a fixed cadence.
 *
 * Done server-side, once per chunk right after TTS produces it, rather than client-side via
 * the Web Audio API's AnalyserNode: cheap (a single pass over PCM samples already in memory —
 * negligible next to TTS synthesis time), computed once rather than sampled every animation
 * frame, and adds no CPU to the browser tab Recall.ai is capturing as the bot's camera feed,
 * where CPU is shared with video encoding and genuinely more precious than in an ordinary tab.
 */

// 30ms windows: fine enough that mouth movement still looks responsive, coarse enough that a
// few seconds of audio is only ~100 samples — trivial to compute and to send alongside the
// audio itself.
export const ENVELOPE_WINDOW_MS = 30

interface WavFormat {
  audioFormat: number
  numChannels: number
  sampleRate: number
  bitsPerSample: number
  dataOffset: number
  dataLength: number
}

/** Walks a WAV file's RIFF chunks to find `fmt ` and `data` — doesn't assume fixed offsets,
 *  since say.ts and kokoro.ts don't even agree on sample format (see below), let alone
 *  offsets, and either could gain an extra chunk (e.g. LIST/INFO) without warning. */
function parseWavFormat(buffer: Buffer): WavFormat {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE buffer')
  }

  let offset = 12
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | undefined
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkDataStart = offset + 8

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkDataStart),
        numChannels: buffer.readUInt16LE(chunkDataStart + 2),
        sampleRate: buffer.readUInt32LE(chunkDataStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkDataStart + 14)
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataStart
      dataLength = Math.min(chunkSize, buffer.length - chunkDataStart)
    }

    // Chunks are word-aligned — an odd-sized chunk has one byte of padding after it.
    offset = chunkDataStart + chunkSize + (chunkSize % 2)
  }

  if (!fmt) throw new Error('WAV buffer has no fmt chunk')
  if (dataOffset === -1) throw new Error('WAV buffer has no data chunk')

  return { ...fmt, dataOffset, dataLength }
}

const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_IEEE_FLOAT = 3

/** say.ts (macOS `say --data-format=LEI16@44100`) produces 16-bit integer PCM.
 *  kokoro.ts (kokoro-js's RawAudio.toBlob(), backing a Float32Array of samples) produces
 *  32-bit IEEE float PCM instead — confirmed by inspecting its actual output, not assumed;
 *  a real Kokoro WAV's fmt chunk reads audioFormat=3, bitsPerSample=32. Both are handled
 *  explicitly; anything else throws rather than silently returning a meaningless envelope. */
function getSampleReader(audioFormat: number, bitsPerSample: number) {
  if (audioFormat === WAVE_FORMAT_PCM && bitsPerSample === 16) {
    return { read: (buf: Buffer, offset: number) => buf.readInt16LE(offset), bytesPerSample: 2, maxAmplitude: 32768 }
  }
  if (audioFormat === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    // IEEE float WAV samples are already normalized to roughly [-1, 1] by convention.
    return { read: (buf: Buffer, offset: number) => buf.readFloatLE(offset), bytesPerSample: 4, maxAmplitude: 1 }
  }
  throw new Error(
    `computeAmplitudeEnvelope only supports 16-bit integer PCM or 32-bit float PCM WAV ` +
      `(got audioFormat=${audioFormat}, ${bitsPerSample}-bit)`
  )
}

/**
 * Returns one RMS amplitude value (0–1) per `windowMs` of audio.
 */
export function computeAmplitudeEnvelope(wav: Buffer, windowMs: number = ENVELOPE_WINDOW_MS): number[] {
  const { audioFormat, numChannels, sampleRate, bitsPerSample, dataOffset, dataLength } = parseWavFormat(wav)
  const { read, bytesPerSample, maxAmplitude } = getSampleReader(audioFormat, bitsPerSample)

  const frameSize = bytesPerSample * numChannels
  const totalFrames = Math.floor(dataLength / frameSize)
  const framesPerWindow = Math.max(1, Math.round((sampleRate * windowMs) / 1000))
  const windowCount = Math.max(1, Math.ceil(totalFrames / framesPerWindow))

  const envelope: number[] = new Array(windowCount).fill(0)
  for (let w = 0; w < windowCount; w++) {
    const startFrame = w * framesPerWindow
    const endFrame = Math.min(totalFrames, startFrame + framesPerWindow)

    let sumSquares = 0
    let frameCount = 0
    for (let frame = startFrame; frame < endFrame; frame++) {
      const frameOffset = dataOffset + frame * frameSize
      let channelSum = 0
      for (let ch = 0; ch < numChannels; ch++) {
        channelSum += read(wav, frameOffset + ch * bytesPerSample)
      }
      const sample = channelSum / numChannels
      sumSquares += sample * sample
      frameCount++
    }

    const rms = frameCount > 0 ? Math.sqrt(sumSquares / frameCount) : 0
    envelope[w] = Math.min(1, rms / maxAmplitude)
  }

  // Real speech RMS never approaches the theoretical maximum sample value each window was
  // just normalized against — loud conversational speech tops out around 0.15–0.25 on that
  // scale (confirmed empirically against both engines' real output), a much narrower range
  // than the old simulated babble (0.45–1.0) the mouth-open animation was tuned against.
  // Rescaling each chunk against its own peak instead means its loudest moment always reads
  // as fully open and quieter moments scale proportionally beneath it — a fixed gain would
  // either under-boost quiet chunks or clip loud ones, so this is peak-relative, not absolute.
  const peak = Math.max(...envelope)
  const SILENCE_PEAK_THRESHOLD = 0.01 // skip rescaling a near-silent chunk — nothing to boost,
  // and amplifying it would turn noise floor into a wide-open mouth for a chunk that should
  // barely move at all.
  if (peak > SILENCE_PEAK_THRESHOLD) {
    for (let w = 0; w < envelope.length; w++) {
      envelope[w] = Math.min(1, envelope[w] / peak)
    }
  }

  return envelope
}
