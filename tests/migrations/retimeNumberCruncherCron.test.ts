import mongoose from 'mongoose'
import agenda from '../../src/jobs/index.js'
import migration from '../../migrations/20260911000000-retime-number-cruncher-cron.js'
import setupIntTest from '../utils/setupIntTest.js'

/* Covers the two halves this migration has to move together: the agent document's saved
   `triggers.cron` (which agent.model only ever fills when undefined, so an existing agent
   keeps its original trigger forever) and the separate agendaJobs document that actually
   carries the live schedule. Missing either one leaves the agent firing at the old time.
   setupIntTest() does not clear agendaJobs, so each test manages its own cleanup. */
setupIntTest()

const agents = () => mongoose.connection.db!.collection('baseusers')
const agendaJobs = () => mongoose.connection.db!.collection('agendaJobs')
const params = () => ({ name: migration.name, context: { db: mongoose.connection.db! }, path: undefined })

const OLD_CRON = { expression: '0 3 * * *' }
const NEW_CRON = { expression: '0 4 * * *', timezone: 'America/New_York' }

async function seedAgent(overrides: Record<string, unknown> = {}) {
  const _id = new mongoose.Types.ObjectId()
  await agents().insertOne({ _id, __t: 'Agent', agentType: 'numberCruncher', triggers: { cron: OLD_CRON }, ...overrides })
  return _id
}

async function seedCronJob(agentId: unknown) {
  await agendaJobs().insertOne({
    name: 'cronAgent',
    type: 'normal',
    data: { agentId },
    repeatInterval: OLD_CRON.expression,
    nextRunAt: new Date()
  })
}

describe('retime-number-cruncher-cron migration', () => {
  /* Neither collection is cleared by setupIntTest: it only wipes collections mongoose has a
     registered model for, and this file reaches both through the raw driver the way the
     migration itself does. Without this, agents leak across tests and the counts drift. */
  beforeEach(async () => {
    await agenda.cancel({})
    await agents().deleteMany({})
  })
  afterAll(async () => {
    await agenda.cancel({})
    await agents().deleteMany({})
  })

  test('up moves the saved trigger to 4am America/New_York and drops the stale schedule', async () => {
    const agentId = await seedAgent()
    await seedCronJob(agentId)

    expect(await migration.up(params())).toBe(1)

    const agent = await agents().findOne({ _id: agentId })
    expect(agent!.triggers.cron).toEqual(NEW_CRON)
    /* Deleted, not rewritten: the next boot recreates it from the trigger above, which is
       the only way it picks up a correctly-computed nextRunAt (see the migration file). */
    expect(await agendaJobs().countDocuments({ name: 'cronAgent' })).toBe(0)
  })

  test('up deletes a schedule whose data.agentId was stored as a string rather than an ObjectId', async () => {
    const agentId = await seedAgent()
    await seedCronJob(String(agentId))

    expect(await migration.up(params())).toBe(1)
    expect(await agendaJobs().countDocuments({ name: 'cronAgent' })).toBe(0)
  })

  test('up leaves a hand-tuned Number Cruncher on its own expression', async () => {
    const custom = { expression: '30 2 * * *' }
    const agentId = await seedAgent({ triggers: { cron: custom } })
    await seedCronJob(agentId)

    expect(await migration.up(params())).toBe(0)

    const agent = await agents().findOne({ _id: agentId })
    expect(agent!.triggers.cron).toEqual(custom)
    expect(await agendaJobs().countDocuments({ name: 'cronAgent' })).toBe(1)
  })

  test('up leaves another agent type that happens to share the old expression alone', async () => {
    const agentId = await seedAgent({ agentType: 'scorekeeper' })
    await seedCronJob(agentId)

    expect(await migration.up(params())).toBe(0)

    const agent = await agents().findOne({ _id: agentId })
    expect(agent!.triggers.cron).toEqual(OLD_CRON)
    expect(await agendaJobs().countDocuments({ name: 'cronAgent' })).toBe(1)
  })

  test("up does not touch another agent's cronAgent job", async () => {
    const numberCruncherId = await seedAgent()
    const otherId = await seedAgent({ agentType: 'scorekeeper' })
    await seedCronJob(numberCruncherId)
    await seedCronJob(otherId)

    expect(await migration.up(params())).toBe(1)

    const remaining = await agendaJobs().find({ name: 'cronAgent' }).toArray()
    expect(remaining).toHaveLength(1)
    expect(String(remaining[0].data.agentId)).toBe(String(otherId))
  })

  test('up is idempotent: a second run after a successful migration is a no-op', async () => {
    await seedAgent()

    expect(await migration.up(params())).toBe(1)
    expect(await migration.up(params())).toBe(0)
  })

  test('down reverts the trigger to the old expression and drops the timezone', async () => {
    const agentId = await seedAgent()
    await seedCronJob(agentId)

    await migration.up(params())
    await seedCronJob(agentId) // stand in for the schedule a boot would have recreated

    expect(await migration.down(params())).toBe(1)

    const agent = await agents().findOne({ _id: agentId })
    expect(agent!.triggers.cron).toEqual(OLD_CRON)
    expect(agent!.triggers.cron.timezone).toBeUndefined()
    expect(await agendaJobs().countDocuments({ name: 'cronAgent' })).toBe(0)
  })
})
