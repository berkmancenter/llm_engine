import agenda from '../../../src/jobs/index.js'
import schedule from '../../../src/jobs/schedule.js'

beforeAll(async () => {
  await agenda._ready
})

beforeEach(async () => {
  await agenda.cancel({ name: 'archiveEvent' })
})
afterAll(async () => {
  await agenda.cancel({ name: 'archiveEvent' })
  await agenda.close({ force: true })
})

test('queue deduplicates event ID and does not reset delivered or retrying work', async () => {
  await schedule.archiveEvent('event-1')
  const [job] = await agenda.jobs({ name: 'archiveEvent' })
  job.attrs.data.status = 'delivered'
  job.attrs.data.attempts = 2
  await job.save()
  await schedule.archiveEvent('event-1')
  const jobs = await agenda.jobs({ name: 'archiveEvent' })
  expect(jobs).toHaveLength(1)
  expect(jobs[0].attrs.data.status).toBe('delivered')
  expect(jobs[0].attrs.data.attempts).toBe(2)
})

test('a scheduled retry survives Agenda handler completion', async () => {
  agenda.define('archiveEvent', async (job) => {
    const { data } = job.attrs
    data.status = 'retry'
    job.schedule(new Date(Date.now() + 60000))
    await job.save()
  })
  await schedule.archiveEvent('event-2')
  const [job] = await agenda.jobs({ name: 'archiveEvent' })
  await job.run()
  const [saved] = await agenda.jobs({ name: 'archiveEvent' })
  expect(saved.attrs.data.status).toBe('retry')
  expect(saved.attrs.nextRunAt!.getTime()).toBeGreaterThan(Date.now())
})

test('explicit retry resets terminal failures, but leaves delivered work intact', async () => {
  await schedule.archiveEvent('event-3')
  const [job] = await agenda.jobs({ name: 'archiveEvent' })
  job.attrs.data.status = 'failed'
  job.attrs.data.attempts = 6
  await job.save()
  await schedule.retryArchiveEvent('event-3')
  const [saved] = await agenda.jobs({ name: 'archiveEvent' })
  expect(saved.attrs.data.status).toBe('queued')
  expect(saved.attrs.data.attempts).toBe(0)
})
