import { jest } from '@jest/globals'

/* langsmith/traceable must be mocked with unstable_mockModule + a dynamic import AFTER
   it — see tests/CLAUDE.md "Mocking" section. A plain jest.mock() (even inside
   beforeEach, as tests/models/agent.model.test.ts's "LangSmith tracing behavior" block
   does) is a documented no-op under this project's ESM Jest setup: the module under
   test is statically imported elsewhere before any jest.mock() call could run, so the
   real langsmith/traceable is always what executes.

   Every other import in this file — including setupIntTest and the fixtures — must
   ALSO be dynamic and come after the mock registration: setupIntTest statically imports
   src/jobs, which pulls in agentDispatcher.js, which pulls in the real
   agent.model/index.ts and therefore the real langsmith/traceable, all before this
   file's own top-level code would run if imported statically. A static import of
   setupIntTest at the top of this file was tried first and silently defeated the mock
   for exactly this reason. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTraceable = jest.fn<(...args: any[]) => any>((fn) => fn)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetCurrentRunTree = jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('langsmith/traceable', () => ({
  traceable: mockTraceable,
  getCurrentRunTree: mockGetCurrentRunTree
}))

const mongoose = (await import('mongoose')).default
const { default: setupIntTest } = await import('../../utils/setupIntTest.js')
const { insertUsers, registeredUser } = await import('../../fixtures/user.fixture.js')
const { publicTopic, conversationAgentsEnabled } = await import('../../fixtures/conversation.fixture.js')
const { insertTopics } = await import('../../fixtures/topic.fixture.js')
const { Agent, Conversation } = await import('../../../src/models/index.js')
const { setAgentTypes } = await import('../../../src/models/user.model/agent.model/index.js')
const { default: defaultAgentTypes } = await import('../../../src/agents/index.js')

setupIntTest()

const TEST_AGENT_TYPE = {
  name: 'Test Agent',
  description: 'A minimal agent type for trace metadata assertions',
  respond: jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]),
  evaluate: jest.fn()
}

describe('agent model LangSmith trace metadata (conversationId, costPhase)', () => {
  let conversation

  beforeEach(async () => {
    mockTraceable.mockClear()
    mockTraceable.mockImplementation((fn) => fn)
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
    conversation = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId(), active: true })
    await conversation.save()
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })

  it('respond() tags the trace with conversationId and costPhase liveEvent', async () => {
    setAgentTypes({ traceMetadataTestType: TEST_AGENT_TYPE })

    const agent = new Agent({
      agentType: 'traceMetadataTestType',
      conversation,
      llmModel: 'gpt-4',
      llmPlatform: 'openai',
      active: true
    })
    await agent.save()

    await agent.respond()

    expect(mockTraceable).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        name: 'traceMetadataTestType',
        metadata: expect.objectContaining({
          llmModel: 'gpt-4',
          llmPlatform: 'openai',
          conversationId: conversation._id.toString(),
          costPhase: 'liveEvent'
        })
      })
    )
  })

  it('onConversationEvent() tags the trace with the STOPPED conversation id and costPhase postEvent', async () => {
    const mockOnConversationEvent = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([])
    setAgentTypes({
      traceMetadataTestType: { ...TEST_AGENT_TYPE, onConversationEvent: mockOnConversationEvent }
    })

    // This agent's OWN conversation is `conversation`, but the event it is tagging
    // is for a DIFFERENT, already-stopped conversation — onConversationEvent must
    // trace under the stopped conversation's id, not its own.
    const agent = new Agent({
      agentType: 'traceMetadataTestType',
      conversation,
      llmModel: 'gpt-4',
      llmPlatform: 'openai',
      active: true
    })
    await agent.save()

    const evt = { type: 'conversationStopped' as const, conversationId: 'stopped-conv-id' }
    await agent.onConversationEvent(evt)

    expect(mockOnConversationEvent).toHaveBeenCalledWith(evt)
    expect(mockTraceable).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        name: 'traceMetadataTestType',
        metadata: expect.objectContaining({
          llmModel: 'gpt-4',
          llmPlatform: 'openai',
          conversationId: 'stopped-conv-id',
          costPhase: 'postEvent'
        })
      })
    )
  })

  it('does not tag onConversationEvent trace when the agent type has no handler', async () => {
    setAgentTypes({ traceMetadataTestType: TEST_AGENT_TYPE })

    const agent = new Agent({
      agentType: 'traceMetadataTestType',
      conversation,
      llmModel: 'gpt-4',
      llmPlatform: 'openai',
      active: true
    })
    await agent.save()

    const responses = await agent.onConversationEvent({ type: 'conversationStopped', conversationId: 'stopped-conv-id' })

    expect(responses).toEqual([])
    expect(mockTraceable).not.toHaveBeenCalled()
  })
})
