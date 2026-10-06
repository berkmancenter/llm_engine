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
  /** A call-upon phrase matched — play these held chunks now (may be empty, if the call-upon
   *  arrived before any chunk had finished converting to audio — see onChunkReady). */
  onFlush: (chunks: T[]) => void
  /** A chunk finished converting to audio *after* its response was already flushed (onFlush
   *  already fired for it) — deliver it immediately. No new state transition: the response is
   *  already playing, this is just more of the same one. This is what makes a response safe to
   *  call upon before every one of its chunks has finished synthesizing — nothing arriving
   *  afterward is ever silently dropped. */
  onChunkReady: (chunk: T) => void
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
  /**
   * Call synchronously right before starting a chunk's (async) audio conversion — before
   * the caller knows whether this response will already have been called upon by the time
   * that conversion finishes. Lets the queue know to still wait for it before treating the
   * response as fully delivered. Must be paired with exactly one later addAudio or
   * chunkFailed call for the same chunk.
   */
  expectChunk(requestId: string): void
  /** Appends a converted audio chunk — delivered immediately via onChunkReady if this
   *  response was already called upon, otherwise just held until it is. A no-op if this
   *  requestId's TTL already expired. */
  addAudio(requestId: string, chunk: T): void
  /** A chunk's audio conversion failed — same bookkeeping as addAudio (counts against
   *  expectChunk, may complete the response), but nothing is delivered for it. */
  chunkFailed(requestId: string): void
  markResponseDone(requestId: string): void
  /** A call-upon phrase matched — flushes the oldest still-pending response, with whatever
   *  of its audio is ready so far. Returns false (no-op) if nothing is pending, or if a
   *  previously-flushed response hasn't finished delivering all its audio yet — only one
   *  response can ever be "speaking" at a time. */
  callUpon(): boolean
  /** The previously flushed response finished playing in the browser. A no-op if the
   *  currently-speaking response still has more audio coming (its own TTS hasn't all
   *  resolved yet) — the browser just emptied its buffer faster than synthesis could keep
   *  up; the next onChunkReady delivery resumes playback without any state change here. */
  audioFinished(): void
  /** Discards everything held (including whatever is currently speaking), with no
   *  announcement (e.g. on disconnect). */
  reset(): void
  hasPending(): boolean
}

interface HeldResponse<T> {
  chunks: T[]
  done: boolean
  ttlTimer: ReturnType<typeof setTimeout> | null
  /** Chunks whose async conversion has started (expectChunk) but not yet landed (addAudio
   *  or chunkFailed). The response isn't fully delivered while this is above zero, even if
   *  the text stream itself (done) has already finished. */
  outstandingChunks: number
}

/**
 * One instance per conversation. Order is FIFO (oldest pending response is always the one
 * a call-upon phrase flushes), and only the response that's currently sole-pending (on
 * arrival, or after the one ahead of it finishes) triggers the hand-raised announcement —
 * everything else queues silently until its turn. Only one response is ever "active"
 * (called upon, currently speaking) at a time.
 */
export function createPendingQueue<T = unknown>(
  hooks: PendingQueueHooks<T>,
  ttlMs: number = CALL_UPON_TTL_MS
): PendingQueue<T> {
  const held = new Map<string, HeldResponse<T>>()
  const order: string[] = [] // oldest first — order[0] is always what callUpon() flushes next
  let activeRequestId: string | null = null

  function clearOne(requestId: string) {
    const entry = held.get(requestId)
    if (entry?.ttlTimer) clearTimeout(entry.ttlTimer)
    held.delete(requestId)
    const idx = order.indexOf(requestId)
    if (idx !== -1) order.splice(idx, 1)
  }

  function isFullyDelivered(entry: HeldResponse<T>) {
    return entry.done && entry.outstandingChunks === 0
  }

  /** Retires the active response once nothing more will ever arrive for it. */
  function retireIfFullyDelivered(requestId: string, entry: HeldResponse<T>) {
    if (requestId === activeRequestId && isFullyDelivered(entry)) {
      held.delete(requestId)
      activeRequestId = null
    }
  }

  function startResponse(requestId: string) {
    if (held.has(requestId)) return
    held.set(requestId, { chunks: [], done: false, ttlTimer: null, outstandingChunks: 0 })
    order.push(requestId)

    if (order.length === 1) hooks.onAnnounce()

    const entry = held.get(requestId)!
    entry.ttlTimer = setTimeout(() => {
      clearOne(requestId)
      hooks.onDiscard?.(requestId)
      if (order.length === 0) hooks.onIdle()
    }, ttlMs)
  }

  function expectChunk(requestId: string) {
    const entry = held.get(requestId)
    if (entry) entry.outstandingChunks += 1
  }

  function addAudio(requestId: string, chunk: T) {
    const entry = held.get(requestId)
    if (!entry) return
    entry.outstandingChunks = Math.max(0, entry.outstandingChunks - 1)
    if (requestId === activeRequestId) {
      hooks.onChunkReady(chunk)
    } else {
      entry.chunks.push(chunk)
    }
    retireIfFullyDelivered(requestId, entry)
  }

  function chunkFailed(requestId: string) {
    const entry = held.get(requestId)
    if (!entry) return
    entry.outstandingChunks = Math.max(0, entry.outstandingChunks - 1)
    retireIfFullyDelivered(requestId, entry)
  }

  function markResponseDone(requestId: string) {
    const entry = held.get(requestId)
    if (!entry) return
    entry.done = true
    retireIfFullyDelivered(requestId, entry)
  }

  function callUpon(): boolean {
    if (activeRequestId !== null) return false
    if (order.length === 0) return false
    const requestId = order.shift()!
    const entry = held.get(requestId)
    if (!entry) return false

    if (entry.ttlTimer) clearTimeout(entry.ttlTimer)
    entry.ttlTimer = null
    activeRequestId = requestId
    const toSend = entry.chunks
    entry.chunks = []
    hooks.onFlush(toSend)
    retireIfFullyDelivered(requestId, entry)
    return true
  }

  function audioFinished() {
    if (activeRequestId !== null) {
      const entry = held.get(activeRequestId)
      if (entry && !isFullyDelivered(entry)) {
        // More audio for the active response is still being synthesized — the browser just
        // ran out of buffer faster than TTS could keep up. Not real completion: wait for the
        // next onChunkReady delivery instead of announcing/idling mid-response.
        return
      }
      held.delete(activeRequestId)
      activeRequestId = null
    }

    if (order.length > 0) {
      hooks.onAnnounce()
    } else {
      hooks.onIdle()
    }
  }

  function reset() {
    for (const entry of held.values()) {
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer)
    }
    held.clear()
    order.length = 0
    activeRequestId = null
  }

  function hasPending() {
    return order.length > 0
  }

  return {
    startResponse,
    expectChunk,
    addAudio,
    chunkFailed,
    markResponseDone,
    callUpon,
    audioFinished,
    reset,
    hasPending
  }
}
