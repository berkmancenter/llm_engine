import logger from '../config/logger.js'
import agenda from './index.js'

// Bounds how long shutdown waits for in-flight agenda jobs to finish. Sized to fit under the
// platform's own shutdown grace window (e.g. GCE's ACPI/backend-service draining) rather than
// racing it.
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000

/**
 * Stops agenda from picking up new jobs and waits for jobs already running on this instance
 * to finish, bounded by `timeoutMs`. Call this from a SIGTERM handler, before the process
 * exits.
 *
 * Deliberately agenda.drain(), not agenda.stop(): stop() clears the Mongo lock on jobs still
 * running on this instance immediately, which would let another instance start the same job
 * while this one is still executing it. drain() waits for them to finish instead of unlocking
 * them early.
 *
 * If the timeout is hit, an in-flight job is simply abandoned mid-run — no worse than an
 * ungraceful kill, since its lock just sits until lockLifetime expires and another instance
 * retries it (see jobs/define.ts for why lockLifetime is sized above worst-case job duration).
 */
export async function drainAgenda(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<void> {
  let timedOut = false
  await Promise.race([
    agenda.drain().then(() => {
      if (!timedOut) logger.info('Agenda drained cleanly')
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)).then(() => {
      timedOut = true
      logger.warn(`Agenda drain timed out after ${timeoutMs}ms; exiting with jobs still in flight`)
    })
  ])
}
