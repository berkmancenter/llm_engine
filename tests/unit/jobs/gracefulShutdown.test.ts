import agenda from '../../../src/jobs/index.js'
import { drainAgenda } from '../../../src/jobs/gracefulShutdown.js'

/* drainAgenda() backs the SIGTERM handler in src/index.ts. It's deliberately agenda.drain(),
   not agenda.stop(): stop() clears the Mongo lock on jobs still running on this instance
   immediately, which would let another instance start the same job while this one is still
   executing it — see jobs/gracefulShutdown.ts for the full reasoning. */
describe('drainAgenda', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('calls agenda.drain(), not agenda.stop()', async () => {
    const drainSpy = jest.spyOn(agenda, 'drain').mockResolvedValue(undefined)
    const stopSpy = jest.spyOn(agenda, 'stop').mockResolvedValue(undefined)

    await drainAgenda()

    expect(drainSpy).toHaveBeenCalledTimes(1)
    expect(stopSpy).not.toHaveBeenCalled()
  })

  test('resolves once drain finishes, well within the timeout', async () => {
    jest.spyOn(agenda, 'drain').mockResolvedValue(undefined)

    await expect(drainAgenda(60_000)).resolves.toBeUndefined()
  })

  test('resolves anyway if drain takes longer than the timeout, instead of hanging shutdown', async () => {
    // Simulates a job that never finishes (e.g. a hung LLM call): drain() would wait forever.
    jest.spyOn(agenda, 'drain').mockReturnValue(new Promise(() => {}))

    await expect(drainAgenda(10)).resolves.toBeUndefined()
  })
})
