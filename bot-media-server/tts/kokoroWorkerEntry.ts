/**
 * Runs inside the worker thread spawned by kokoroWorkerClient.ts. Loads the Kokoro model once
 * (via the unmodified createKokoroTts from kokoro.ts) and then just relays
 * { id, text } -> { id, audio } / { id, error } messages — all the actual model-loading and
 * per-call option handling (voice, speed, dtype, ...) stays in kokoro.ts, unchanged.
 *
 * Not unit-tested directly: Jest's module mocking doesn't cross a real worker-thread boundary,
 * so the only way to exercise this file for real is against an actually-staged Kokoro model —
 * out of scope for a fast test suite. kokoro.ts's own logic (which this just calls) is fully
 * covered by tts.kokoro.test.ts; kokoroWorkerClient.ts's protocol/error handling is covered by
 * tts.kokoroWorkerClient.test.ts with a mocked Worker.
 */
import { parentPort, workerData } from 'worker_threads'
import { createKokoroTts, KokoroTtsOptions } from './kokoro.js'

interface InboundMessage {
  id: number
  text: string
}

async function main() {
  if (!parentPort) throw new Error('kokoroWorkerEntry must be run inside a worker thread')
  const port = parentPort

  const textToAudio = await createKokoroTts(workerData as KokoroTtsOptions)
  port.postMessage({ type: 'ready' })

  port.on('message', async ({ id, text }: InboundMessage) => {
    try {
      const audio = await textToAudio(text)
      port.postMessage({ type: 'result', id, audio })
    } catch (err) {
      port.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
    }
  })
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  if (parentPort) parentPort.postMessage({ type: 'init-error', message })
  else throw err
})
