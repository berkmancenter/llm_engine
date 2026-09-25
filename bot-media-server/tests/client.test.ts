import { jest } from '@jest/globals'
import { createAudioQueue } from '../public/client.js'

// Deferred promise, so a test can control exactly when a `play()` call resolves —
// mirrors real playback, where `onended`/`onerror` fire asynchronously.
function deferred<T = void>() {
  let resolve: (value: T) => void
  let reject: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve: resolve!, reject: reject! }
}

describe('createAudioQueue', () => {
  test('starts playing immediately on the first push', () => {
    const play = jest.fn(() => new Promise<void>(() => {}))
    createAudioQueue({ play, onFinished: jest.fn() }).push('a')

    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith('a')
  })

  test('does not start a second item until the first resolves', async () => {
    const first = deferred()
    // The second call (for 'b', once 'a' resolves) also needs a real promise back — even
    // though this test never settles it — or playNext's `.then()` throws on `undefined`.
    const play = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(new Promise(() => {}))
    const queue = createAudioQueue({ play, onFinished: jest.fn() })

    queue.push('a')
    queue.push('b')
    expect(play).toHaveBeenCalledTimes(1)

    first.resolve()
    await first.promise
    expect(play).toHaveBeenCalledTimes(2)
    expect(play).toHaveBeenLastCalledWith('b')
  })

  test('calls onFinished only once the queue drains, not between items', async () => {
    const first = deferred()
    const second = deferred()
    const play = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const onFinished = jest.fn()
    const queue = createAudioQueue({ play, onFinished })

    queue.push('a')
    queue.push('b')

    first.resolve()
    await first.promise
    expect(onFinished).not.toHaveBeenCalled()

    second.resolve()
    await second.promise
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  test('a rejected play() still advances to the next item, not stuck', async () => {
    const play = jest
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error('boom')))
      .mockReturnValueOnce(Promise.resolve())
    const onFinished = jest.fn()
    const queue = createAudioQueue({ play, onFinished })

    queue.push('a')
    queue.push('b')
    await new Promise((resolve) => setImmediate(resolve))

    expect(play).toHaveBeenCalledTimes(2)
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  test('pushing while idle after the queue drained starts playback again', async () => {
    const play = jest.fn(() => Promise.resolve())
    const onFinished = jest.fn()
    const queue = createAudioQueue({ play, onFinished })

    queue.push('a')
    await new Promise((resolve) => setImmediate(resolve))
    expect(onFinished).toHaveBeenCalledTimes(1)

    queue.push('b')
    await new Promise((resolve) => setImmediate(resolve))
    expect(play).toHaveBeenCalledTimes(2)
    expect(onFinished).toHaveBeenCalledTimes(2)
  })
})
