/**
 * Same (text) => Promise<Buffer> shape as createKokoroTts (kokoro.ts), but loads the model and
 * runs every inference call inside a separate worker thread instead of this process's own event
 * loop.
 *
 * Why: Kokoro's CPU inference (onnxruntime, device: 'cpu') is synchronous, CPU-bound work —
 * `await`ing the returned promise doesn't make that work yield the event loop. Run in-process,
 * it blocks everything else this server is doing for the full duration of each call, socket.io's
 * ping/pong included. On a slow enough CPU that's long enough to trip the ping-timeout on both
 * the llm_engine connection (engineSocket.ts) and the browser connection (app.ts) at once —
 * confirmed as the cause of a production incident where both disconnected in the same second
 * mid-response, leaving the bot's hand stuck raised with no event left that could ever clear it.
 * Moving inference to a worker thread keeps the main thread free to service both sockets
 * regardless of how long any single synthesis call takes.
 */
import { Worker } from 'worker_threads'
import path from 'path'
import { fileURLToPath } from 'url'
import { KokoroTtsOptions } from './kokoro.js'

const __dir = path.dirname(fileURLToPath(import.meta.url))

export interface KokoroWorkerDeps {
  /** Overridable for tests — the real one spawns an actual OS thread. */
  createWorker: (options: KokoroTtsOptions) => Worker
}

const defaultCreateWorker = (options: KokoroTtsOptions): Worker =>
  // execArgv isn't passed explicitly — Worker inherits process.execArgv (including this
  // process's own --loader ts-node/esm) from the parent by default, which is what lets the
  // worker resolve kokoroWorkerEntry.ts the same way every other import in this codebase does.
  new Worker(path.join(__dir, 'kokoroWorkerEntry.js'), { workerData: options })

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { type: 'result'; id: number; audio: Buffer }
  | { type: 'error'; id: number; message: string }

export async function createKokoroTtsWorker(
  options: KokoroTtsOptions = {},
  deps: KokoroWorkerDeps = { createWorker: defaultCreateWorker }
): Promise<(text: string) => Promise<Buffer>> {
  const worker = deps.createWorker(options)
  let nextId = 0
  const pending = new Map<number, { resolve: (audio: Buffer) => void; reject: (err: Error) => void }>()

  function rejectAllPending(err: Error) {
    for (const { reject } of pending.values()) reject(err)
    pending.clear()
  }

  worker.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'result') {
      pending.get(msg.id)?.resolve(Buffer.from(msg.audio))
      pending.delete(msg.id)
    } else if (msg.type === 'error') {
      pending.get(msg.id)?.reject(new Error(msg.message))
      pending.delete(msg.id)
    }
  })
  worker.on('error', (err) => rejectAllPending(err))
  worker.on('exit', (code) => {
    if (code !== 0) rejectAllPending(new Error(`Kokoro TTS worker exited unexpectedly (code ${code})`))
  })

  await new Promise<void>((resolve, reject) => {
    const onReadyOrInitError = (msg: WorkerMessage) => {
      if (msg.type === 'ready') {
        worker.off('message', onReadyOrInitError)
        resolve()
      } else if (msg.type === 'init-error') {
        worker.off('message', onReadyOrInitError)
        reject(new Error(msg.message))
      }
    }
    worker.on('message', onReadyOrInitError)
    worker.once('error', reject)
  })

  return function textToAudio(text: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, text })
    })
  }
}
