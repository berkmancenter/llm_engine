// How long (ms) to hold a pending contribution while waiting for a call-upon trigger
export const CALL_UPON_TTL_MS = 60_000

// Generic over the audio chunk type (T) — this queue only ever holds, counts, and forwards
// chunks; it never inspects their content, so it doesn't care whether callers hand it base64
// strings, Buffers, or anything else. Defaults to unknown so a caller that doesn't care can
// still write createPendingQueue(hooks) without picking a type.
export interface PendingQueueHooks<T = unknown> {
  /** A response became the sole thing waiting for "go ahead" — signal hand-raised + chime.
   *  Fired both when a new response first arrives alone, and when a previous one finishes
   *  playing and this one is still queued behind it (re-announce). */
  onAnnounce: () => void
  /** A call-upon phrase matched — play these held chunks now. */
  onFlush: (chunks: T[]) => void
  /** Nothing left waiting — go idle. */
  onIdle: () => void
  /** A response's TTL expired before it was called upon and its chunks were discarded.
   *  Optional — purely informational (e.g. for logging). */
  onDiscard?: (requestId: string) => void
}

export interface PendingQueue<T = unknown> {
  /**
   * Registers a new held response, starting its TTL countdown. Must be called
   * synchronously as soon as a response's first chunk arrives — before that chunk is
   * converted to audio — so ordering is correct even though the conversion itself
   * happens asynchronously. A no-op if this requestId is already registered.
   */
  startResponse(requestId: string): void
  /** Appends a converted audio chunk. A no-op if the request's TTL already expired. */
  addAudio(requestId: string, chunk: T): void
  markResponseDone(requestId: string): void
  /** A call-upon phrase matched — flushes (and removes) the oldest still-pending response. */
  callUpon(): void
  /** The previously flushed response finished playing in the browser. */
  audioFinished(): void
  /** Discards everything held, with no announcement (e.g. on disconnect). */
  reset(): void
  hasPending(): boolean
}

interface HeldResponse<T> {
  chunks: T[]
  done: boolean
  ttlTimer: ReturnType<typeof setTimeout> | null
}

/**
 * One instance per conversation. Order is FIFO (oldest pending response is always the one
 * a call-upon phrase flushes), and only the response that's currently sole-pending (on
 * arrival, or after the one ahead of it finishes) triggers the hand-raised announcement —
 * everything else queues silently until its turn.
 */
export function createPendingQueue<T = unknown>(
  hooks: PendingQueueHooks<T>,
  ttlMs: number = CALL_UPON_TTL_MS
): PendingQueue<T> {
  const held = new Map<string, HeldResponse<T>>()
  const order: string[] = [] // oldest first — order[0] is always what callUpon() flushes next

  function clearOne(requestId: string) {
    const entry = held.get(requestId)
    if (entry?.ttlTimer) clearTimeout(entry.ttlTimer)
    held.delete(requestId)
    const idx = order.indexOf(requestId)
    if (idx !== -1) order.splice(idx, 1)
  }

  function startResponse(requestId: string) {
    if (held.has(requestId)) return
    held.set(requestId, { chunks: [], done: false, ttlTimer: null })
    order.push(requestId)

    if (order.length === 1) hooks.onAnnounce()

    const entry = held.get(requestId)!
    entry.ttlTimer = setTimeout(() => {
      clearOne(requestId)
      hooks.onDiscard?.(requestId)
      if (order.length === 0) hooks.onIdle()
    }, ttlMs)
  }

  function addAudio(requestId: string, chunk: T) {
    held.get(requestId)?.chunks.push(chunk)
  }

  function markResponseDone(requestId: string) {
    const entry = held.get(requestId)
    if (entry) entry.done = true
  }

  function callUpon() {
    if (order.length === 0) return
    const requestId = order[0]
    const entry = held.get(requestId)
    if (!entry) return
    clearOne(requestId)
    hooks.onFlush(entry.chunks)
  }

  function audioFinished() {
    if (order.length > 0) {
      hooks.onAnnounce()
    } else {
      hooks.onIdle()
    }
  }

  function reset() {
    for (const requestId of [...order]) clearOne(requestId)
  }

  function hasPending() {
    return order.length > 0
  }

  return { startResponse, addAudio, markResponseDone, callUpon, audioFinished, reset, hasPending }
}
