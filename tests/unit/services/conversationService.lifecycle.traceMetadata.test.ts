import { jest } from '@jest/globals'

/* Same ordering rule as tests/unit/models/agentModel.traceMetadata.test.ts: mock
   langsmith/traceable with unstable_mockModule, then import EVERYTHING (including
   setupIntTest and fixtures) dynamically, after the mock registration. lifecycle.ts's
   own import graph (via agentService -> the Agent model) pulls in the real
   langsmith/traceable and llmChain.js's pingLLM, so both are mocked here too — a
   static import anywhere above the mock call would silently defeat it. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTraceable = jest.fn<(...args: any[]) => any>((fn) => fn)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetCurrentRunTree = jest.fn<(...args: any[]) => any>()
const mockGetChatPromptResponse = jest.fn<(...args: unknown[]) => Promise<string>>().mockResolvedValue('Mock summary')

jest.unstable_mockModule('langsmith/traceable', () => ({
  traceable: mockTraceable,
  getCurrentRunTree: mockGetCurrentRunTree
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
// socket.io is never initialized in this narrow unit-test context (no src/app.js
// bootstrap), so the real websocketGateway crashes on getConnection(); doStopConversation
// only calls these two methods, and neither is under test here.
jest.unstable_mockModule('../src/websockets/websocketGateway.js', () => ({
  default: {
    broadcastTranscriptStatusChange: jest.fn(),
    broadcastConversationAlmostEnding: jest.fn()
  }
}))

const { default: setupIntTest } = await import('../../utils/setupIntTest.js')
const { insertUsers, registeredUser } = await import('../../fixtures/user.fixture.js')
const { publicTopic } = await import('../../fixtures/conversation.fixture.js')
const { insertTopics } = await import('../../fixtures/topic.fixture.js')
const { Conversation } = await import('../../../src/models/index.js')
const { doStopConversation } = await import('../../../src/services/conversation.service/lifecycle.js')

setupIntTest()

describe('doStopConversation LangSmith trace metadata', () => {
  beforeEach(async () => {
    mockTraceable.mockClear()
    mockTraceable.mockImplementation((fn) => fn)
    mockGetChatPromptResponse.mockClear()
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
  })

  it('tags the stop-time summary trace with conversationId and costPhase postEvent', async () => {
    const conversation = new Conversation({
      name: 'Stop Test',
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

    await doStopConversation(conversation)

    expect(mockGetChatPromptResponse).toHaveBeenCalled()
    expect(mockTraceable).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        name: 'conversationSummary',
        metadata: expect.objectContaining({
          conversationId: conversation._id.toString(),
          costPhase: 'postEvent'
        })
      })
    )
  })

  it('does not build a summary (or trace one) when the conversation has no transcript', async () => {
    const conversation = new Conversation({
      name: 'No Transcript Test',
      owner: registeredUser._id,
      topic: publicTopic._id,
      active: true,
      agents: [],
      adapters: [],
      messages: [],
      channels: []
    })
    await conversation.save()

    await doStopConversation(conversation)

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(mockTraceable).not.toHaveBeenCalled()
  })
})
