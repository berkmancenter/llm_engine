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
const { default: config } = await import('../../../src/config/config.js')
const { default: schedule } = await import('../../../src/jobs/schedule.js')
const { default: agentDispatcher } = await import('../../../src/jobs/agentDispatcher.js')
const { default: websocketGateway } = await import('../../../src/websockets/websocketGateway.js')
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

  test('queues archive delivery after persisting the summary when enabled', async () => {
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)
    const previous = config.bkcArchive.exportEnabled
    config.bkcArchive.exportEnabled = true
    const queued = jest.spyOn(schedule, 'archiveEvent').mockImplementation(async (id) => {
      const saved = await Conversation.findById(id)
      expect(saved!.summary).toBe('Mock summary')
    })
    try {
      await doStopConversation(conversation)
      expect(queued).toHaveBeenCalledWith(conversation._id.toString())
    } finally {
      config.bkcArchive.exportEnabled = previous
      queued.mockRestore()
    }
  })

  test('enqueue failure still completes stop and dispatches post-event analysis', async () => {
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)
    const previous = config.bkcArchive.exportEnabled
    const previousAnalysis = config.disablePostEventAnalysis
    config.bkcArchive.exportEnabled = true
    config.disablePostEventAnalysis = false
    const queued = jest.spyOn(schedule, 'archiveEvent').mockRejectedValue(new Error('queue unavailable'))
    const dispatch = jest.spyOn(agentDispatcher, 'dispatch').mockResolvedValue(undefined)
    const logged = jest.spyOn(logger, 'error')
    const broadcast = jest.spyOn(websocketGateway, 'broadcastConversationStopped')
    broadcast.mockClear()
    try {
      await expect(doStopConversation(conversation)).resolves.toBe(conversation)
      const saved = await Conversation.findById(conversation._id)
      expect(saved!.active).toBe(false)
      expect(saved!.summary).toBe('Mock summary')
      expect(queued).toHaveBeenCalledWith(conversation._id.toString())
      expect(logged).toHaveBeenCalledWith(`Archive export enqueue failed event=${conversation._id}`)
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'conversationStopped', conversationId: conversation._id.toString() }),
        expect.any(Object),
        expect.any(Object)
      )
      expect(broadcast).toHaveBeenCalledWith(conversation)
    } finally {
      config.bkcArchive.exportEnabled = previous
      config.disablePostEventAnalysis = previousAnalysis
      queued.mockRestore()
      dispatch.mockRestore()
      logged.mockRestore()
    }
  })

  test.each([
    { enabled: false, messages: 20 },
    { enabled: true, messages: 10 }
  ])('does not enqueue when enabled=$enabled and transcript messages=$messages', async ({ enabled, messages }) => {
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, messages)
    const previous = config.bkcArchive.exportEnabled
    config.bkcArchive.exportEnabled = enabled
    const queued = jest.spyOn(schedule, 'archiveEvent').mockResolvedValue(undefined)
    try {
      await doStopConversation(conversation)
      expect(queued).not.toHaveBeenCalled()
      const saved = await Conversation.findById(conversation._id)
      expect(saved!.active).toBe(false)
      if (messages === 20) expect(saved!.summary).toBe('Mock summary')
      else expect(saved!.summary).toBeFalsy()
    } finally {
      config.bkcArchive.exportEnabled = previous
      queued.mockRestore()
    }
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
