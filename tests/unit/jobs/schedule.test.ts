import agenda from '../../../src/jobs/index.js'
import schedule from '../../../src/jobs/schedule.js'
import setupIntTest from '../../utils/setupIntTest.js'

/* periodicAgent/cronAgent share one job name across every agent (see jobs/define.ts) -
   agent identity comes from data.agentId instead. These tests exist specifically to catch
   a regression where two agents' schedules collide into one document, which would happen
   silently if periodicAgent/cronAgent ever went back to agenda.every()'s bare upsert (keyed
   on {name, type:'single'} with no data in it at all). setupIntTest() does not clear
   agendaJobs (it only wipes collections with a registered Mongoose model), so each test
   clears it explicitly. */
setupIntTest()

const clearAgendaJobs = async () => {
  await agenda.cancel({})
}

describe('schedule.periodicAgent / cronAgent use one job name per type, keyed by data.agentId', () => {
  beforeEach(clearAgendaJobs)
  afterAll(clearAgendaJobs)

  test('two agents scheduling a periodic job get two separate documents, not one collided document', async () => {
    await schedule.periodicAgent('60 seconds', { agentId: 'agent-a' })
    await schedule.periodicAgent('60 seconds', { agentId: 'agent-b' })

    const jobs = await agenda.jobs({ name: 'periodicAgent' })
    expect(jobs).toHaveLength(2)
    expect(jobs.map((j) => j.attrs.data.agentId).sort()).toEqual(['agent-a', 'agent-b'])
  })

  test('two agents scheduling a cron job get two separate documents', async () => {
    await schedule.cronAgent('0 * * * *', { agentId: 'agent-a' })
    await schedule.cronAgent('0 * * * *', { agentId: 'agent-b' })

    const jobs = await agenda.jobs({ name: 'cronAgent' })
    expect(jobs).toHaveLength(2)
    expect(jobs.map((j) => j.attrs.data.agentId).sort()).toEqual(['agent-a', 'agent-b'])
  })

  test('rescheduling the same agent upserts in place rather than creating a second document', async () => {
    await schedule.periodicAgent('60 seconds', { agentId: 'agent-a' })
    await schedule.periodicAgent('30 seconds', { agentId: 'agent-a' })

    const jobs = await agenda.jobs({ name: 'periodicAgent', 'data.agentId': 'agent-a' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].attrs.repeatInterval).toBe('30 seconds')
  })

  test('periodicAgentExists/cronAgentExists are scoped to the specific agent', async () => {
    await schedule.periodicAgent('60 seconds', { agentId: 'agent-a' })

    expect(await schedule.periodicAgentExists('agent-a')).toBe(true)
    expect(await schedule.periodicAgentExists('agent-b')).toBe(false)
    // A periodic schedule must not satisfy the cron existence check for the same agent.
    expect(await schedule.cronAgentExists('agent-a')).toBe(false)
  })

  test('cancelPeriodicAgent only removes the targeted agent\'s job', async () => {
    await schedule.periodicAgent('60 seconds', { agentId: 'agent-a' })
    await schedule.periodicAgent('60 seconds', { agentId: 'agent-b' })

    await schedule.cancelPeriodicAgent('agent-a')

    expect(await schedule.periodicAgentExists('agent-a')).toBe(false)
    expect(await schedule.periodicAgentExists('agent-b')).toBe(true)
  })

  test('cancelCronAgent only removes the targeted agent\'s job', async () => {
    await schedule.cronAgent('0 * * * *', { agentId: 'agent-a' })
    await schedule.cronAgent('0 * * * *', { agentId: 'agent-b' })

    await schedule.cancelCronAgent('agent-a')

    expect(await schedule.cronAgentExists('agent-a')).toBe(false)
    expect(await schedule.cronAgentExists('agent-b')).toBe(true)
  })
})

describe('schedule.agentResponse uses a shared job name (one-off jobs, no uniqueness needed)', () => {
  beforeEach(clearAgendaJobs)
  afterAll(clearAgendaJobs)

  test('each call inserts its own document under the generic name', async () => {
    await schedule.agentResponse({ agentId: 'agent-a', message: { _id: 'message-1' } })
    await schedule.agentResponse({ agentId: 'agent-a', message: { _id: 'message-2' } })

    const jobs = await agenda.jobs({ name: 'agentResponse' })
    expect(jobs).toHaveLength(2)
    expect(jobs.map((j) => j.attrs.data.message._id).sort()).toEqual(['message-1', 'message-2'])
  })
})
