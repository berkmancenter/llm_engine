// Plays queued audio chunks one at a time, FIFO. `play` and `onFinished` are injected —
// same dependency-injection pattern as pendingQueue.ts's hooks and auth.ts's refresh
// callback — so this is unit-testable with no real Audio/Blob/browser APIs at all (see
// bot-media-server/tests/client.test.ts). An error from `play` still advances to the next
// item, matching the original inline behavior: a bad chunk shouldn't wedge playback.
export function createAudioQueue({ play, onFinished }) {
  const queue = []
  let playing = false

  function playNext() {
    if (queue.length === 0) {
      playing = false
      onFinished()
      return
    }
    playing = true
    const item = queue.shift()
    play(item).then(playNext, playNext)
  }

  return {
    push(item) {
      queue.push(item)
      if (!playing) playNext()
    }
  }
}
