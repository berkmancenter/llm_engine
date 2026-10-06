import { EventEmitter } from 'events'
import type { Worker } from 'worker_threads'
import { jest } from '@jest/globals'
import { createKokoroTtsWorker } from '../tts/kokoroWorkerClient.js'

/** A real EventEmitter gives correct on/off/once semantics for free — only postMessage needs
 *  to be a mock, since that's the one method the client actually calls on the worker. */
class FakeWorker extends EventEmitter {
  postMessage = jest.fn()
}

function readyWorker() {
  const worker = new FakeWorker()
  const creating = createKokoroTtsWorker({}, { createWorker: () => worker as unknown as Worker })
  // Model load happens before 'ready' in the real worker — simulate that completing.
  worker.emit('message', { type: 'ready' })
  return { worker, creating }
}

describe('createKokoroTtsWorker', () => {
  it('resolves once the worker signals ready, and round-trips text to audio by request id', async () => {
    const { worker, creating } = readyWorker()
    const textToAudio = await creating

    const resultPromise = textToAudio('hello')
    expect(worker.postMessage).toHaveBeenCalledWith({ id: 0, text: 'hello' })

    worker.emit('message', { type: 'result', id: 0, audio: Buffer.from([1, 2, 3]) })
    const result = await resultPromise

    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result).toEqual(Buffer.from([1, 2, 3]))
  })

  it('rejects creation if the worker reports an init error before ready', async () => {
    const worker = new FakeWorker()
    const creating = createKokoroTtsWorker({}, { createWorker: () => worker as unknown as Worker })

    worker.emit('message', { type: 'init-error', message: 'model not found' })

    await expect(creating).rejects.toThrow('model not found')
  })

  it('correlates concurrent calls by request id, even resolved out of order', async () => {
    const { worker, creating } = readyWorker()
    const textToAudio = await creating

    const first = textToAudio('first')
    const second = textToAudio('second')

    // Resolve the second request before the first.
    worker.emit('message', { type: 'result', id: 1, audio: Buffer.from([2]) })
    worker.emit('message', { type: 'result', id: 0, audio: Buffer.from([1]) })

    await expect(first).resolves.toEqual(Buffer.from([1]))
    await expect(second).resolves.toEqual(Buffer.from([2]))
  })

  it('rejects only the specific pending call a worker error message names', async () => {
    const { worker, creating } = readyWorker()
    const textToAudio = await creating

    const first = textToAudio('first')
    const second = textToAudio('second')

    worker.emit('message', { type: 'error', id: 0, message: 'synthesis failed' })
    worker.emit('message', { type: 'result', id: 1, audio: Buffer.from([9]) })

    await expect(first).rejects.toThrow('synthesis failed')
    await expect(second).resolves.toEqual(Buffer.from([9]))
  })

  it('rejects every pending call when the worker thread errors', async () => {
    const { worker, creating } = readyWorker()
    const textToAudio = await creating

    const first = textToAudio('first')
    const second = textToAudio('second')

    worker.emit('error', new Error('worker crashed'))

    await expect(first).rejects.toThrow('worker crashed')
    await expect(second).rejects.toThrow('worker crashed')
  })

  it('rejects every pending call when the worker exits unexpectedly', async () => {
    const { worker, creating } = readyWorker()
    const textToAudio = await creating

    const pending = textToAudio('hello')
    worker.emit('exit', 1)

    await expect(pending).rejects.toThrow(/exited unexpectedly \(code 1\)/)
  })

  it('does not treat a clean exit (code 0) as a failure for calls already pending', async () => {
    const { worker, creating } = readyWorker()
    const textToAudio = await creating

    const pending = textToAudio('hello')
    worker.emit('exit', 0)
    worker.emit('message', { type: 'result', id: 0, audio: Buffer.from([7]) })

    await expect(pending).resolves.toEqual(Buffer.from([7]))
  })
})
