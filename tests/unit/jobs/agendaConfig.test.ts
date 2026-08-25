import agenda from '../../../src/jobs/index.js'

/* These values match agenda's own library defaults, but jobs/index.ts sets them explicitly
   rather than relying on that inheritance — multiple autoscaled instances now poll and
   process from the same `agendaJobs` collection, so it's worth being deliberate about how
   much concurrent job-processing capacity that adds per instance. This test exists so a
   silent, unintentional change to these values (e.g. an upstream agenda major bump changing
   its defaults) gets caught. */
describe('agenda instance configuration', () => {
  test('polls for due jobs every 10 seconds', () => {
    expect(agenda._processEvery).toBe(10_000)
  })

  test('caps global and per-job-name concurrency explicitly', () => {
    expect(agenda._maxConcurrency).toBe(20)
    expect(agenda._defaultConcurrency).toBe(5)
  })
})
