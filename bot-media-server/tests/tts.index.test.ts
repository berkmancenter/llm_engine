import { jest } from '@jest/globals'
import { createTts, TtsDeps } from '../tts/index.js'

// A bare jest.fn().mockResolvedValue(...) chain (no generic) infers mockResolvedValue's
// parameter as `never` under this project's TS setup — keep separately, properly-typed mock
// references rather than accessing them back through the (plainly-typed) TtsDeps object.
function makeDeps() {
  const say = jest.fn<(text: string, voice?: string) => Promise<Buffer>>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createKokoroTts = jest.fn<(...args: any[]) => Promise<any>>()
  const deps: TtsDeps = { say, createKokoroTts }
  return { deps, say, createKokoroTts }
}

describe('createTts', () => {
  it('defaults to the kokoro engine when none is specified', async () => {
    const { deps, say, createKokoroTts } = makeDeps()
    createKokoroTts.mockResolvedValue(jest.fn())

    await createTts({}, deps)

    expect(createKokoroTts).toHaveBeenCalledTimes(1)
    expect(say).not.toHaveBeenCalled()
  })

  it('builds a say-backed function that forwards the configured voice on every call', async () => {
    const { deps, say } = makeDeps()
    const sayAudio = Buffer.from('say-audio')
    say.mockResolvedValue(sayAudio)

    const tts = await createTts({ engine: 'say', voice: 'Samantha' }, deps)
    const result = await tts('hello')

    expect(result).toBe(sayAudio)
    expect(say).toHaveBeenCalledWith('hello', 'Samantha')
  })

  it('creates a kokoro engine with the top-level voice merged into engine-specific options', async () => {
    const { deps, createKokoroTts } = makeDeps()
    const mockKokoroFn = jest.fn()
    createKokoroTts.mockResolvedValue(mockKokoroFn)

    const tts = await createTts({ engine: 'kokoro', voice: 'af_heart', kokoro: { modelDir: '/models' } }, deps)

    expect(createKokoroTts).toHaveBeenCalledWith({ modelDir: '/models', voice: 'af_heart' })
    expect(tts).toBe(mockKokoroFn)
  })
})
