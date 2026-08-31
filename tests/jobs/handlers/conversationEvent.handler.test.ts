import mongoose from 'mongoose'
import { Conversation, Agent } from '../../../src/models/index.js'
import { publicTopic, conversationAgentsEnabled } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture.js'
import handlers from '../../../src/jobs/handlers/conversationEvent.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import messageService from '../../../src/services/message.service.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

const testAgentTypes = {
  periodic: {
    respond: jest.fn(),
    evaluate: jest.fn(),
    onConversationEvent: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    name: 'Test Periodic Agent',
    description: 'A periodic test agent',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 300 } },
    priority: 10,
    llmTemplateVars: {},
    defaultLLMTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel
  }
}

describe('conversationEvent handler', () => {
  let conversation
  let agent

  beforeAll(() => {
    setAgentTypes(testAgentTypes)
  })

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
    conversation = new Conversation({ ...conversationAgentsEnabled, active: true })
    await conversation.save()
    agent = new Agent({ agentType: 'periodic', conversation: conversation._id, active: true })
    await agent.save()
    jest.restoreAllMocks()
  })

  const makeJob = (overrides: Record<string, unknown> = {}) => ({
    attrs: {
      data: {
        agentId: agent._id.toString(),
        event: { type: 'conversationStopped', conversationId: conversation._id.toString() },
        ...overrides
      }
    }
  })

  test('does not throw when agent is not found', async () => {
    const fakeId = new mongoose.Types.ObjectId()
    await expect(
      handlers.conversationEvent({
        attrs: { data: { agentId: fakeId.toString(), event: { type: 'conversationStopped', conversationId: 'conv-1' } } }
      })
    ).resolves.not.toThrow()
  })

  test('calls onConversationEvent with the event', async () => {
    const onConversationEventSpy = jest.spyOn(Agent.prototype, 'onConversationEvent').mockResolvedValue([])

    const event = { type: 'conversationStopped', conversationId: conversation._id.toString() }
    await handlers.conversationEvent(makeJob({ event }))

    expect(onConversationEventSpy).toHaveBeenCalledWith(event)
  })

  test('calls newMessageHandler for each valid response', async () => {
    const responses = [
      { visible: true, message: 'Summary posted', messageType: 'text', channels: [] },
      { visible: true, message: 'Also this', messageType: 'text', channels: [] }
    ]
    jest.spyOn(Agent.prototype, 'onConversationEvent').mockResolvedValue(responses)
    const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

    await handlers.conversationEvent(makeJob())

    expect(newMessageSpy).toHaveBeenCalledTimes(2)
  })

  test('does not call newMessageHandler when agent returns no responses', async () => {
    jest.spyOn(Agent.prototype, 'onConversationEvent').mockResolvedValue([])
    const newMessageSpy = jest.spyOn(messageService, 'newMessageHandler').mockResolvedValue([])

    await handlers.conversationEvent(makeJob())

    expect(newMessageSpy).not.toHaveBeenCalled()
  })

  test('does not throw when onConversationEvent fails', async () => {
    jest.spyOn(Agent.prototype, 'onConversationEvent').mockRejectedValue(new Error('LLM error'))

    await expect(handlers.conversationEvent(makeJob())).resolves.not.toThrow()
  })

  /* Simulates a from-scratch retry after a mid-job kill, or a duplicate dispatch of the same
     event (e.g. autoStopConversation retried before its `active` flip was persisted). Without
     the claimResponseTrigger guard, this would call onConversationEvent (a real LLM call) and
     post a second recap message for the same event. */
  test('does not call onConversationEvent a second time for the same event', async () => {
    const onConversationEventSpy = jest.spyOn(Agent.prototype, 'onConversationEvent').mockResolvedValue([])

    await handlers.conversationEvent(makeJob())
    await handlers.conversationEvent(makeJob())

    expect(onConversationEventSpy).toHaveBeenCalledTimes(1)
  })

  test('still calls onConversationEvent for a different event type on the same conversation', async () => {
    const onConversationEventSpy = jest.spyOn(Agent.prototype, 'onConversationEvent').mockResolvedValue([])

    await handlers.conversationEvent(
      makeJob({ event: { type: 'conversationStopped', conversationId: conversation._id.toString() } })
    )
    await handlers.conversationEvent(
      makeJob({
        event: { type: 'participantJoined', conversationId: conversation._id.toString(), userId: 'user-1', name: 'Alice' }
      })
    )

    expect(onConversationEventSpy).toHaveBeenCalledTimes(2)
  })

  test('calls onConversationEvent for each distinct participant joining the same conversation', async () => {
    const onConversationEventSpy = jest.spyOn(Agent.prototype, 'onConversationEvent').mockResolvedValue([])
    const convId = conversation._id.toString()

    await handlers.conversationEvent(
      makeJob({ event: { type: 'participantJoined', conversationId: convId, userId: 'user-1', name: 'Alice' } })
    )
    await handlers.conversationEvent(
      makeJob({ event: { type: 'participantJoined', conversationId: convId, userId: 'user-2', name: 'Bob' } })
    )

    expect(onConversationEventSpy).toHaveBeenCalledTimes(2)
  })
})
