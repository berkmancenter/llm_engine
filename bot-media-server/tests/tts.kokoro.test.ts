import { jest } from '@jest/globals'

// kokoro-js and @huggingface/transformers aren't injectable the way AuthManager/tts are
// elsewhere in this codebase — kokoro.ts imports them directly — so this uses the project's
// unstable_mockModule + dynamic-import-after pattern (see tests/CLAUDE.md) instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFromPretrained = jest.fn<(...args: any[]) => Promise<any>>()
const mockEnv: Record<string, unknown> = {}

jest.unstable_mockModule('kokoro-js', () => ({
  KokoroTTS: { from_pretrained: mockFromPretrained }
}))
jest.unstable_mockModule('@huggingface/transformers', () => ({
  env: mockEnv
}))

const { createKokoroTts } = await import('../tts/kokoro.js')

function fakeWavBlob(bytes: number[]) {
  return new Blob([new Uint8Array(bytes)])
}

// A bare jest.fn().mockResolvedValue(...) chain (no generic) infers mockResolvedValue's
// parameter as `never` under this project's TS setup — give it a real signature up front.
function makeMockGenerate(bytes: number[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockGenerate = jest.fn<(...args: any[]) => Promise<{ toBlob: () => Blob }>>()
  mockGenerate.mockResolvedValue({ toBlob: () => fakeWavBlob(bytes) })
  return mockGenerate
}

describe('createKokoroTts', () => {
  beforeEach(() => {
    mockFromPretrained.mockReset()
    for (const key of Object.keys(mockEnv)) delete mockEnv[key]
  })

  it('loads the model once and reuses it for every call', async () => {
    const mockGenerate = makeMockGenerate([1, 2, 3])
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate })

    const tts = await createKokoroTts()
    await tts('hello')
    await tts('world')

    expect(mockFromPretrained).toHaveBeenCalledTimes(1)
    expect(mockGenerate).toHaveBeenCalledTimes(2)
  })

  it('resolves the generated audio blob to a raw Buffer, not base64', async () => {
    const mockGenerate = makeMockGenerate([1, 2, 3, 4])
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate })

    const tts = await createKokoroTts()
    const result = await tts('hello there')

    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('uses sensible defaults for model id, dtype, voice, and speed when none are given', async () => {
    const mockGenerate = makeMockGenerate([1])
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate })

    const tts = await createKokoroTts()
    await tts('hello')

    expect(mockFromPretrained).toHaveBeenCalledWith('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
      device: 'cpu'
    })
    expect(mockGenerate).toHaveBeenCalledWith('hello', { voice: 'af_heart', speed: 1 })
  })

  it('passes through a configured voice, model id, dtype, and speed', async () => {
    const mockGenerate = makeMockGenerate([1])
    mockFromPretrained.mockResolvedValue({ generate: mockGenerate })

    const tts = await createKokoroTts({ voice: 'am_adam', modelId: 'some/other-model', dtype: 'fp16', speed: 1.25 })
    await tts('hello')

    expect(mockFromPretrained).toHaveBeenCalledWith('some/other-model', { dtype: 'fp16', device: 'cpu' })
    expect(mockGenerate).toHaveBeenCalledWith('hello', { voice: 'am_adam', speed: 1.25 })
  })

  it('points @huggingface/transformers env at the configured model directory', async () => {
    mockFromPretrained.mockResolvedValue({ generate: makeMockGenerate([1]) })

    await createKokoroTts({ modelDir: '/tmp/my-models' })

    expect(mockEnv.localModelPath).toBe('/tmp/my-models')
    expect(mockEnv.cacheDir).toBe('/tmp/my-models')
  })

  it('defaults to not allowing remote model downloads, but can be opted into', async () => {
    mockFromPretrained.mockResolvedValue({ generate: makeMockGenerate([1]) })

    await createKokoroTts()
    expect(mockEnv.allowRemoteModels).toBe(false)

    await createKokoroTts({ allowRemoteModels: true })
    expect(mockEnv.allowRemoteModels).toBe(true)
  })

  it('wraps a load failure with a pointer to the README staging instructions', async () => {
    mockFromPretrained.mockRejectedValue(new Error('file not found locally'))

    await expect(createKokoroTts({ modelDir: '/tmp/nonexistent' })).rejects.toThrow(/README\.md/)
  })
})
