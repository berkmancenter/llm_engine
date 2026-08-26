import config from '../../../src/config/config.js'
import agenda from '../../../src/jobs/index.js'
import defineJob from '../../../src/jobs/define.js'
import schedule from '../../../src/jobs/schedule.js'
import { startJobs } from '../../../src/jobs/startup.js'

/* Every defineJob.* function used to call agenda.start() redundantly on its own (11 calls per
   boot, once per job). Now startJobs() starts the processing loop exactly once, up front. */
describe('startJobs', () => {
  const originalEnv = config.env

  afterEach(() => {
    config.env = originalEnv
    jest.restoreAllMocks()
  })

  test('starts agenda exactly once', async () => {
    config.env = 'production' // startJobs() no-ops under config.env === 'test'
    const startSpy = jest.spyOn(agenda, 'start').mockResolvedValue(undefined)
    // Stub out the individual define/schedule calls: this test is only about the agenda.start()
    // wiring, not about re-verifying job definition/scheduling (covered elsewhere) or writing
    // real cron job documents to the shared test database.
    Object.keys(defineJob).forEach((key) => jest.spyOn(defineJob, key as keyof typeof defineJob).mockResolvedValue(undefined))
    Object.keys(schedule).forEach((key) => jest.spyOn(schedule, key as keyof typeof schedule).mockResolvedValue(undefined))

    await startJobs()

    expect(startSpy).toHaveBeenCalledTimes(1)
  })

  test('does nothing in the test environment', async () => {
    const startSpy = jest.spyOn(agenda, 'start').mockResolvedValue(undefined)

    await startJobs()

    expect(startSpy).not.toHaveBeenCalled()
  })
})
