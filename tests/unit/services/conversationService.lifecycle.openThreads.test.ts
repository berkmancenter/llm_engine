import { jest } from '@jest/globals'

/* Covers doStopConversation's open-threads extraction specifically: runs for every conversation
   regardless of Topic (most don't have one; a Topic only matters later, to proactiveGroupAgent's
   topic-scoped read of these results), gated only on the same transcript-message threshold
   summary already uses. Mirrors conversationService.lifecycle.summary.test.ts's mocking pattern
   exactly. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()

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
const { default: agentDispatcher } = await import('../../../src/jobs/agentDispatcher.js')

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

const makeConversation = async (overrides: { topic?: unknown } = {}) => {
  const conversation = new Conversation({
    name: 'Open Threads Test',
    owner: registeredUser._id,
    topic: 'topic' in overrides ? overrides.topic : publicTopic._id,
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

// Distinguishes the summary call (no schema, 6th arg) from the open-threads call (schema
// passed) so each gets a response shape it can actually use.
function mockResponses(openThreads: string[]) {
  mockGetChatPromptResponse.mockImplementation(async (...args: unknown[]) => (args[5] ? { openThreads } : 'Mock summary'))
}

describe('doStopConversation open-threads extraction', () => {
  beforeEach(async () => {
    mockGetChatPromptResponse.mockReset()
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
  })

  test('extracts and persists open threads when there is enough transcript', async () => {
    mockResponses(['What is our actual budget ceiling?', 'Who owns the vendor relationship?'])
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)

    await doStopConversation(conversation)

    const updated = await Conversation.findById(conversation._id)
    expect(updated!.postEventAnalysis?.openThreads).toEqual([
      'What is our actual budget ceiling?',
      'Who owns the vendor relationship?'
    ])
    expect(updated!.postEventAnalysis?.openThreadsProvenance?.generator).toBe('openThreadsExtraction')
  })

  test('does not set openThreads when the extraction finds nothing', async () => {
    mockResponses([])
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)

    await doStopConversation(conversation)

    const updated = await Conversation.findById(conversation._id)
    expect(updated!.postEventAnalysis?.openThreads).toBeFalsy()
    expect(updated!.postEventAnalysis?.openThreadsProvenance).toBeFalsy()
  })

  test('saves the summary and finishes the stop when open-thread extraction fails', async () => {
    mockGetChatPromptResponse.mockImplementation(async (...args: unknown[]) => {
      if (args[5]) throw new Error('LLM unavailable')
      return 'Mock summary'
    })
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)
    const dispatch = jest.spyOn(agentDispatcher, 'dispatch').mockResolvedValue(undefined)

    try {
      await expect(doStopConversation(conversation)).resolves.toBe(conversation)

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.postEventAnalysis?.summary).toBe('Mock summary')
      expect(updated!.postEventAnalysis?.openThreads).toBeFalsy()
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'conversationStopped', conversationId: conversation._id.toString() }),
        expect.any(Object),
        expect.any(Object)
      )
    } finally {
      dispatch.mockRestore()
    }
  })

  test('keeps the first 4 open threads when the model returns more', async () => {
    const fiveThreads = ['Thread 1?', 'Thread 2?', 'Thread 3?', 'Thread 4?', 'Thread 5?']
    // The real helper throws when the model's answer fails the schema it was given, so this
    // fake validates against that schema too; otherwise a too-strict schema would go unnoticed.
    mockGetChatPromptResponse.mockImplementation(async (...args: unknown[]) =>
      args[5] ? (args[5] as { parse: (value: unknown) => unknown }).parse({ openThreads: fiveThreads }) : 'Mock summary'
    )
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 20)

    await doStopConversation(conversation)

    const updated = await Conversation.findById(conversation._id)
    expect(updated!.postEventAnalysis?.summary).toBe('Mock summary')
    expect(updated!.postEventAnalysis?.openThreads).toEqual(fiveThreads.slice(0, 4))
  })

  test('still extracts open threads when the conversation has no topic', async () => {
    mockResponses(['What is our actual budget ceiling?'])
    const conversation = await makeConversation({ topic: undefined })
    await seedTranscriptMessages(conversation._id, 20)

    await doStopConversation(conversation)

    const updated = await Conversation.findById(conversation._id)
    expect(updated!.postEventAnalysis?.summary).toBe('Mock summary')
    expect(updated!.postEventAnalysis?.openThreads).toEqual(['What is our actual budget ceiling?'])
  })

  test('skips extraction when below the transcript-message threshold, same gate as summary', async () => {
    mockResponses(['should never be used'])
    const conversation = await makeConversation()
    await seedTranscriptMessages(conversation._id, 10)

    await doStopConversation(conversation)

    const updated = await Conversation.findById(conversation._id)
    expect(updated!.postEventAnalysis?.summary).toBeFalsy()
    expect(updated!.postEventAnalysis?.openThreads).toBeFalsy()
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })
})
