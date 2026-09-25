// Builds a minimal valid mono WAV buffer from raw samples — used wherever a test needs real
// WAV bytes for audioEnvelope.ts to parse (as opposed to fakeTts's usual Buffer.from(text)
// stand-in, which isn't a WAV at all and exercises the "envelope computation failed" fallback
// path instead — see engineSocket.test.ts).
function buildWavHeader(dataSize: number, sampleRate: number, audioFormat: number, bitsPerSample: number): Buffer {
  const numChannels = 1
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const header = Buffer.alloc(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(audioFormat, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)
  return header
}

/** 16-bit integer PCM (audioFormat 1) — what say.ts produces. */
export default function buildTestWav(samples: number[], sampleRate = 8000): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], i * 2)
  return Buffer.concat([buildWavHeader(data.length, sampleRate, 1, 16), data])
}

/** 32-bit IEEE float PCM (audioFormat 3) — what kokoro.ts actually produces (confirmed
 *  against real kokoro-js output, not assumed — see audioEnvelope.ts). Samples are expected
 *  in roughly [-1, 1], the WAV float convention. */
export function buildTestWavFloat32(samples: number[], sampleRate = 24000): Buffer {
  const data = Buffer.alloc(samples.length * 4)
  for (let i = 0; i < samples.length; i++) data.writeFloatLE(samples[i], i * 4)
  return Buffer.concat([buildWavHeader(data.length, sampleRate, 3, 32), data])
}
