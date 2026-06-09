import mongoose from 'mongoose'
import Agent from '../../../src/models/user.model/agent.model/index.js'
import access, { AccessDeniedError } from '../../../src/auth/access.js'
import schedule from '../../../src/jobs/schedule.js'
import agentDispatcher from '../../../src/jobs/agentDispatcher.js'
import { ConversationEvent, ReadScope } from '../../../src/types/index.types.js'

const event: ConversationEvent = { type: 'conversationStopped', conversationId: 'conv-1' }
const scope: ReadScope = { type: 'conversation', id: 'conv-1', topicId: 'topic-1' }

function makeAgent() {
  return {
    _id: new mongoose.Types.ObjectId(),
    capabilities: { read: [{ type: 'topic', id: 'topic-1' }], write: [] }
  }
}

function mockFind(agents: unknown[]) {
  return jest.spyOn(Agent, 'find').mockReturnValue({
    populate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(agents)
    })
  } as unknown as ReturnType<typeof Agent.find>)
}

describe('agentDispatcher.dispatch', () => {
  let assertCanReadSpy: jest.SpyInstance
  let scheduleSpy: jest.SpyInstance

  beforeEach(() => {
    assertCanReadSpy = jest.spyOn(access, 'assertCanRead')
    scheduleSpy = jest.spyOn(schedule, 'conversationEvent').mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('does not schedule anything when no active agents', async () => {
    mockFind([])

    await agentDispatcher.dispatch(event, scope)

    expect(scheduleSpy).not.toHaveBeenCalled()
  })

  test('schedules a job for each agent that passes assertCanRead', async () => {
    const agents = [makeAgent(), makeAgent()]
    mockFind(agents)
    assertCanReadSpy.mockReturnValue(undefined)

    await agentDispatcher.dispatch(event, scope)

    expect(scheduleSpy).toHaveBeenCalledTimes(2)
  })

  test('skips agents that fail assertCanRead', async () => {
    const agents = [makeAgent(), makeAgent(), makeAgent()]
    mockFind(agents)
    assertCanReadSpy
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new AccessDeniedError('no access')
      })

    await agentDispatcher.dispatch(event, scope)

    expect(scheduleSpy).toHaveBeenCalledTimes(2)
  })

  test('passes the event and agentId to schedule', async () => {
    const agent = makeAgent()
    mockFind([agent])
    assertCanReadSpy.mockReturnValue(undefined)

    await agentDispatcher.dispatch(event, scope)

    expect(scheduleSpy).toHaveBeenCalledWith({ agentId: agent._id.toString(), event })
  })
})
