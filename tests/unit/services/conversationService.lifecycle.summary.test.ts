import { jest } from '@jest/globals'

const mockGetChatPromptResponse = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('Mock summary')

jest.unstable_mockModule('langsmith/traceable', () => ({
  traceable: (fn) => fn,
  getCurrentRunTree: jest.fn()
}))
jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getSinglePromptResponse: jest.fn(),
  getRAGAugmentedResponse: jest.fn(),
  getChatPromptResponse: mockGetChatPromptResponse,
  shouldUseStructuredOutput: jest.fn(),
  pingLLM: jest.fn(),
  getStructuredResponseChain: jest.fn(),
  getAgentStructuredResponse: jest.fn(),
  extractToolCallTraceFromAgentResult: jest.fn()
}))
jest.unstable_mockModule('../src/websockets/websocketGateway.js', () => ({
  default: {
    broadcastTranscriptStatusChange: jest.fn(),
    broadcastConversationAlmostEnding: jest.fn(),
    broadcastConversationStopped: jest.fn()
  }
}))

const { default: setupIntTest } = await import('../../utils/setupIntTest.js')
const { insertUsers, registeredUser } = await import('../../fixtures/user.fixture.js')
const { publicTopic } = await import('../../fixtures/conversation.fixture.js')
const { insertTopics } = await import('../../fixtures/topic.fixture.js')
const { Conversation, Message } = await import('../../../src/models/index.js')
const { doStopConversation } = await import('../../../src/services/conversation.service/lifecycle.js')
const { default: logger } = await import('../../../src/config/logger.js')

setupIntTest()

const seedTranscriptMessages = async (conversationId: unknown, count: number) => {
  const msgs = await Message.insertMany(
    Array.from({ length: count }, (_, i) => ({
      conversation: conversationId,
      channels: ['transcript'],
      body: `Speaker: message ${i + 1}`,
      pseudonym: 'Speaker',
      pseudonymId: conversationId
    }))
  )
  await Conversation.findByIdAndUpdate(conversationId, { $push: { messages: { $each: msgs.map((m) => m._id) } } })
}

const makeConversation = async () => {
  const conversation = new Conversation({
    name: 'Summary Test',
    owner: registeredUser._id,
    topic: publicTopic._id,
    active: true,
    agents: [],
    adapters: [],
    messages: [],
    channels: [],
    transcript: { status: 'active' }
  })
  await conversation.save()
  return conversation
}

describe('doStopConversation summary generation', () => {
  beforeEach(async () => {
    mockGetChatPromptResponse.mockClear()
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
  })

  test('generates and persists a summary when there are sufficient transcript messages', async () => {
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)

    await doStopConversation(conversation)

    const updated = await Conversation.findById(conversation._id)
    expect(mockGetChatPromptResponse).toHaveBeenCalled()
    expect(updated!.summary).toBe('Mock summary')
  })

  test('skips summary generation when there are fewer than 20 transcript messages', async () => {
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 10)
    const loggerInfoSpy = jest.spyOn(logger, 'info')

    await doStopConversation(conversation)

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(loggerInfoSpy).toHaveBeenCalledWith(expect.stringMatching(/Skipping summary.*only 10 transcript message/))
  })
})
