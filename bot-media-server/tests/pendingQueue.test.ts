import { jest } from '@jest/globals'
import { createPendingQueue } from '../pendingQueue.js'

function makeHooks() {
  return {
    onAnnounce: jest.fn(),
    onFlush: jest.fn(),
    onIdle: jest.fn(),
    onDiscard: jest.fn()
  }
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
    queue.addAudio('req-1', 'chunk-1a')
    queue.addAudio('req-1', 'chunk-1b')
    queue.startResponse('req-2')
    queue.addAudio('req-2', 'chunk-2a')

    queue.callUpon()
    expect(hooks.onFlush).toHaveBeenCalledTimes(1)
    expect(hooks.onFlush).toHaveBeenCalledWith(['chunk-1a', 'chunk-1b'])
    expect(queue.hasPending()).toBe(true) // req-2 still queued
  })

  test('addAudio is a no-op for an unregistered or already-flushed requestId', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)
    expect(() => queue.addAudio('never-registered', 'chunk')).not.toThrow()

    queue.startResponse('req-1')
    queue.callUpon() // flushes and removes req-1
    expect(() => queue.addAudio('req-1', 'late-chunk')).not.toThrow()
  })

  test('audioFinished re-announces when something is still queued, otherwise goes idle', () => {
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.startResponse('req-2')
    queue.callUpon() // flushes req-1, req-2 remains

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

  test('reset discards everything with no announcement, and clears pending TTL timers', () => {
    jest.useFakeTimers()
    const hooks = makeHooks()
    const queue = createPendingQueue(hooks, 60_000)

    queue.startResponse('req-1')
    queue.startResponse('req-2')
    hooks.onAnnounce.mockClear()

    queue.reset()
    expect(queue.hasPending()).toBe(false)
    expect(hooks.onIdle).not.toHaveBeenCalled()
    expect(hooks.onAnnounce).not.toHaveBeenCalled()

    // TTL timers were actually cleared, not just forgotten about
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
