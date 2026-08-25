import mongoose from 'mongoose'
import agenda from '../../src/jobs/index.js'
import migration from '../../migrations/20260824000000-rename-legacy-agent-job-names.js'
import setupIntTest from '../utils/setupIntTest.js'

/* Regression coverage for the rename this migration exists to do safely: a job document
   left under an old per-agent name (`periodic - <id>`, `cron - <id>`, `response - <id>`) is
   invisible to every instance forever once nothing define()s that name anymore (see the
   migration file for the full mechanism). setupIntTest() does not clear agendaJobs, so
   each test manages its own cleanup. */
setupIntTest()

const agendaJobs = () => mongoose.connection.db!.collection('agendaJobs')
const context = () => ({ db: mongoose.connection.db! })
const params = (name: string) => ({ name, context: context(), path: undefined })

describe('rename-legacy-agent-job-names migration', () => {
  beforeEach(async () => {
    await agenda.cancel({})
  })
  afterAll(async () => {
    await agenda.cancel({})
  })

  test('up renames legacy per-agent job names to the generic name, preserving data.agentId', async () => {
    await agendaJobs().insertMany([
      { name: 'periodic - agent-a', type: 'normal', data: { agentId: 'agent-a' }, nextRunAt: new Date() },
      { name: 'cron - agent-b', type: 'normal', data: { agentId: 'agent-b' }, nextRunAt: new Date() },
      { name: 'response - agent-c', type: 'normal', data: { agentId: 'agent-c' }, nextRunAt: new Date() }
    ])

    const migrated = await migration.up(params(migration.name))
    expect(migrated).toBe(3)

    const docs = await agendaJobs().find({}).toArray()
    const byAgent = Object.fromEntries(docs.map((d) => [d.data.agentId, d.name]))
    expect(byAgent['agent-a']).toBe('periodicAgent')
    expect(byAgent['agent-b']).toBe('cronAgent')
    expect(byAgent['agent-c']).toBe('agentResponse')
  })

  test('up leaves already-generic-named documents untouched', async () => {
    await agendaJobs().insertOne({
      name: 'periodicAgent',
      type: 'normal',
      data: { agentId: 'agent-a' },
      nextRunAt: new Date()
    })

    const migrated = await migration.up(params(migration.name))
    expect(migrated).toBe(0)

    const doc = await agendaJobs().findOne({ 'data.agentId': 'agent-a' })
    expect(doc!.name).toBe('periodicAgent')
  })

  test('up is idempotent: a second run after a successful migration is a no-op', async () => {
    await agendaJobs().insertOne({
      name: 'periodic - agent-a',
      type: 'normal',
      data: { agentId: 'agent-a' },
      nextRunAt: new Date()
    })

    expect(await migration.up(params(migration.name))).toBe(1)
    expect(await migration.up(params(migration.name))).toBe(0)
  })

  test('up does not touch an unrelated job name that happens to contain the same words', async () => {
    await agendaJobs().insertOne({
      name: 'a periodic - report generator',
      type: 'normal',
      data: {},
      nextRunAt: new Date()
    })

    await migration.up(params(migration.name))

    const doc = await agendaJobs().findOne({})
    expect(doc!.name).toBe('a periodic - report generator')
  })

  test('down reverts documents renamed by up back to their legacy name', async () => {
    await agendaJobs().insertMany([
      { name: 'periodic - agent-a', type: 'normal', data: { agentId: 'agent-a' }, nextRunAt: new Date() },
      { name: 'cron - agent-b', type: 'normal', data: { agentId: 'agent-b' }, nextRunAt: new Date() }
    ])
    await migration.up(params(migration.name))

    await migration.down!(params(migration.name))

    const docs = await agendaJobs().find({}).toArray()
    const byAgent = Object.fromEntries(docs.map((d) => [d.data.agentId, d.name]))
    expect(byAgent['agent-a']).toBe('periodic - agent-a')
    expect(byAgent['agent-b']).toBe('cron - agent-b')
  })
})
