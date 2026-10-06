import { jest } from '@jest/globals'
import { createPendingQueue } from '../pendingQueue.js'

function makeHooks() {
  return {
    onAnnounce: jest.fn(),
    onFlush: jest.fn(),
    onChunkReady: jest.fn(),
    onIdle: jest.fn(),
    onDiscard: jest.fn()
  }
}

/** Mirrors the real engineSocket.ts call sequence for one chunk whose TTS has already
 *  resolved by the time this returns: expectChunk, then addAudio. */
function deliverChunk(queue: ReturnType<typeof createPendingQueue>, requestId: string, chunk: unknown) {
  queue.expectChunk(requestId)
  queue.addAudio(requestId, chunk)
}

describe('pendingQueue', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('announces on the first response, not on a second arriving while the first is still pending', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    expect(hooks.onAnnounce).toHaveBeenCalledTimes(1)

    queue.startResponse('req-2')
    expect(hooks.onAnnounce).toHaveBeenCalledTimes(1) // still just once

    expect(queue.hasPending()).toBe(true)
  })

  test('re-registering the same requestId is a no-op', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)
    queue.startResponse('req-1')
    queue.startResponse('req-1')
    expect(hooks.onAnnounce).toHaveBeenCalledTimes(1)
  })

  test('callUpon flushes the oldest pending response first (FIFO), with its accumulated audio', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    deliverChunk(queue, 'req-1', 'chunk-1a')
    deliverChunk(queue, 'req-1', 'chunk-1b')
    queue.startResponse('req-2')
    deliverChunk(queue, 'req-2', 'chunk-2a')

    expect(queue.callUpon()).toBe(true)
    expect(hooks.onFlush).toHaveBeenCalledTimes(1)
    expect(hooks.onFlush).toHaveBeenCalledWith(['chunk-1a', 'chunk-1b'])
    expect(queue.hasPending()).toBe(true) // req-2 still queued
  })

  test('callUpon is a no-op (returns false) with nothing pending', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)
    expect(queue.callUpon()).toBe(false)
    expect(hooks.onFlush).not.toHaveBeenCalled()
  })

  test('a chunk whose TTS finishes after call-upon is still delivered, not dropped', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.expectChunk('req-1') // TTS started, not resolved yet

    expect(queue.callUpon()).toBe(true)
    expect(hooks.onFlush).toHaveBeenCalledWith([]) // nothing ready yet — speaking starts anyway

    queue.addAudio('req-1', 'late-chunk') // TTS resolves now, after the flush
    expect(hooks.onChunkReady).toHaveBeenCalledWith('late-chunk')
  })

  test('a second call-upon while already speaking is a no-op (only one response speaks at a time)', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.expectChunk('req-1') // still outstanding — req-1 isn't fully delivered yet
    queue.startResponse('req-2')

    expect(queue.callUpon()).toBe(true) // activates req-1
    hooks.onFlush.mockClear()

    expect(queue.callUpon()).toBe(false) // req-2 is still queued, but req-1 is still speaking
    expect(hooks.onFlush).not.toHaveBeenCalled()
    expect(queue.hasPending()).toBe(true) // req-2 untouched, still waiting its turn
  })

  test('chunkFailed still counts toward delivery completion, without delivering anything', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.expectChunk('req-1')
    queue.callUpon()
    queue.markResponseDone('req-1')

    queue.chunkFailed('req-1') // the one outstanding chunk failed instead of resolving
    expect(hooks.onChunkReady).not.toHaveBeenCalled()

    // Fully delivered now (done + zero outstanding) despite the failure — audioFinished
    // should treat this as real completion, not wait forever for a chunk that will never land.
    queue.audioFinished()
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
  })

  test('addAudio and chunkFailed are no-ops for an unregistered requestId', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)
    expect(() => queue.addAudio('never-registered', 'chunk')).not.toThrow()
    expect(() => queue.chunkFailed('never-registered')).not.toThrow()
  })

  test('audioFinished does not go idle/re-announce while the active response still has audio coming', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.expectChunk('req-1') // one chunk's TTS still outstanding
    queue.callUpon()
    queue.markResponseDone('req-1') // text stream done, but that one chunk hasn't resolved

    hooks.onAnnounce.mockClear() // startResponse('req-1') already called this once, on arrival
    queue.audioFinished() // browser ran out of buffered audio before the next chunk was ready
    expect(hooks.onIdle).not.toHaveBeenCalled()
    expect(hooks.onAnnounce).not.toHaveBeenCalled()

    queue.addAudio('req-1', 'final-chunk') // now it resolves
    expect(hooks.onChunkReady).toHaveBeenCalledWith('final-chunk')

    queue.audioFinished() // browser finishes playing it — now really done
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
  })

  test('audioFinished re-announces when something is still queued, otherwise goes idle', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.markResponseDone('req-1')
    queue.startResponse('req-2')
    queue.markResponseDone('req-2')
    queue.callUpon() // flushes req-1 (fully delivered already — done, nothing outstanding)

    hooks.onAnnounce.mockClear()
    queue.audioFinished()
    expect(hooks.onAnnounce).toHaveBeenCalledTimes(1)
    expect(hooks.onIdle).not.toHaveBeenCalled()

    queue.callUpon() // flushes req-2, nothing left
    queue.audioFinished()
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
  })

  test('TTL discards a response and goes idle only when nothing else is pending', () => {
    jest.useFakeTimers()
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 1_000)

    queue.startResponse('req-1')
    jest.advanceTimersByTime(1_000)
    expect(hooks.onDiscard).toHaveBeenCalledWith('req-1')
    expect(hooks.onIdle).toHaveBeenCalledTimes(1)
    expect(queue.hasPending()).toBe(false)
  })

  test('TTL discarding one response does not go idle if another is still pending', () => {
    jest.useFakeTimers()
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 1_000)

    queue.startResponse('req-1')
    jest.advanceTimersByTime(500)
    queue.startResponse('req-2') // starts its own independent TTL from now

    jest.advanceTimersByTime(500) // req-1's TTL fires (1000ms since its own start)
    expect(hooks.onDiscard).toHaveBeenCalledWith('req-1')
    expect(hooks.onIdle).not.toHaveBeenCalled() // req-2 still pending
    expect(queue.hasPending()).toBe(true)
  })

  test('calling upon a response clears its TTL — it cannot be discarded once active', () => {
    jest.useFakeTimers()
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 1_000)

    queue.startResponse('req-1')
    queue.expectChunk('req-1') // still outstanding, so callUpon won't fully retire it
    queue.callUpon()

    jest.advanceTimersByTime(60_000)
    expect(hooks.onDiscard).not.toHaveBeenCalled()
  })

  test('reset discards everything with no announcement, including an active (speaking) response', () => {
    jest.useFakeTimers()
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.expectChunk('req-1')
    queue.callUpon() // active, not yet fully delivered
    queue.startResponse('req-2')
    hooks.onAnnounce.mockClear()

    queue.reset()
    expect(queue.hasPending()).toBe(false)
    expect(hooks.onIdle).not.toHaveBeenCalled()
    expect(hooks.onAnnounce).not.toHaveBeenCalled()

    // The active response's late chunk no longer delivers anywhere, and req-1's TTL (if any
    // had still been running) was actually cleared, not just forgotten about.
    queue.addAudio('req-1', 'too-late')
    expect(hooks.onChunkReady).not.toHaveBeenCalled()
    jest.advanceTimersByTime(60_000)
    expect(hooks.onDiscard).not.toHaveBeenCalled()
  })

  test('markResponseDone is inert bookkeeping and never throws', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)
    queue.startResponse('req-1')
    expect(() => queue.markResponseDone('req-1')).not.toThrow()
    expect(() => queue.markResponseDone('never-registered')).not.toThrow()
    expect(queue.hasPending()).toBe(true)
  })
})
