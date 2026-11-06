import { jest } from '@jest/globals'
import { QuestionResultSummary } from '../../../../src/agents/moderatorNotifier/moderatorNotifier.types.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindMessages = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

// moderatorNotifier.ts's existing respond() imports getConversationHistory, which itself imports
// filterForAudience/hideContextOf from this same module — only findMessages is mocked, the rest
// stays real so that static import still resolves.
const actualMessageVisibility = await import('../../../../src/utils/messageVisibility.js')
jest.unstable_mockModule('../src/utils/messageVisibility.js', () => ({
  ...actualMessageVisibility,
  findMessages: mockFindMessages
}))

const { default: moderatorNotifier } = await import('../../../../src/agents/moderatorNotifier/moderatorNotifier.js')

const conversationId = 'conv-1'
const moderatorChannel = { name: 'moderator', direct: false }
const scheduledTime = new Date(Date.now() + 60 * 1000)
const preEventMinutes = 15
const expectedWindowStart = scheduledTime.getTime() - preEventMinutes * 60 * 1000

function buildContext(conversationOverrides: Record<string, unknown> = {}) {
  return {
    __t: 'Agent',
    _id: 'moderator-notifier-agent-1',
    name: 'Moderator Notifier',
    pseudonyms: [{ _id: 'mn-pseudonym-1' }],
    capabilities: { read: [{ type: 'ownConversation' }], write: [{ type: 'ownConversation' }] },
    getLLM: async () => 'fake-llm',
    conversation: {
      _id: conversationId,
      scheduledTime,
      preEventMinutes,
      channels: [moderatorChannel],
      ...conversationOverrides
    }
  }
}

function startedEvent(overrides: Record<string, unknown> = {}) {
  return { type: 'conversationStarted' as const, conversationId, ...overrides }
}

const promptMessage = {
  _id: 'prompt-1',
  body: { type: 'warmUpQuestion', text: 'What brings you here today?' },
  bodyType: 'json',
  prompt: { type: 'text' }
}
const singleChoicePromptMessage = {
  _id: 'prompt-1',
  body: { type: 'warmUpQuestion', text: 'Have you attended one of these before?' },
  bodyType: 'json',
  prompt: {
    type: 'singleChoice',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' }
    ]
  }
}
const answerMessageOne = { _id: 'answer-1', body: 'mostly curiosity', bodyType: 'text', answersPrompt: 'prompt-1' }
const answerMessageTwo = { _id: 'answer-2', body: 'a friend invited me', bodyType: 'text', answersPrompt: 'prompt-1' }

function mockFindMessagesFor({ prompts = [] as unknown[], answers = [] as unknown[] } = {}) {
  mockFindMessages.mockImplementation((_convId: unknown, _audience: unknown, filter: Record<string, unknown>) => {
    if (filter['body.type'] === 'warmUpQuestion') return Promise.resolve(prompts)
    if (filter.answersPrompt) return Promise.resolve(answers)
    return Promise.resolve([])
  })
}

describe('moderatorNotifier.onConversationEvent — warm-up themes on conversationStarted', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  test('returns [] for any event type other than conversationStarted', async () => {
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, { type: 'conversationStopped', conversationId })

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] when the event is about a different conversation', async () => {
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent({ conversationId: 'other-conv' }))

    expect(result).toEqual([])
  })

  test('rejects when the agent lacks read access, same as the dispatcher-gated precedent', async () => {
    const context = buildContext()
    context.capabilities = { read: [], write: [] }

    await expect(moderatorNotifier.onConversationEvent.call(context, startedEvent())).rejects.toThrow()
  })

  test('returns [] without querying the database when no pre-event window was ever configured', async () => {
    mockFindMessagesFor({ prompts: [promptMessage], answers: [answerMessageOne, answerMessageTwo] })
    const context = buildContext({ preEventMinutes: undefined })

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockFindMessages).not.toHaveBeenCalled()
  })

  test('returns [] when no moderator channel exists on the conversation', async () => {
    const context = buildContext({ channels: [] })

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] when there is no warm-up prompt in this conversation', async () => {
    mockFindMessagesFor({})
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] without calling the LLM when there are no warm-up answers', async () => {
    mockFindMessagesFor({ prompts: [promptMessage] })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('posts clustered warm-up themes to the moderator channel for a text question', async () => {
    mockFindMessagesFor({ prompts: [promptMessage], answers: [answerMessageOne, answerMessageTwo] })
    mockGetChatPromptResponse.mockResolvedValue({
      themes: [
        { value: 'Curiosity about the topic', matchingAnswers: [1] },
        { value: 'Came via social connection', matchingAnswers: [2] }
      ]
    })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    const [, , , inputParams] = mockGetChatPromptResponse.mock.calls[0]
    expect(inputParams.answers).toBe('1. mostly curiosity\n2. a friend invited me')

    expect(result).toEqual([
      {
        visible: true,
        message: {
          type: 'questionResults',
          timestamp: expect.objectContaining({ start: expectedWindowStart, end: expect.any(Number) }),
          questionResults: {
            questionType: 'warmUpQuestion',
            question: 'What brings you here today?',
            format: 'text',
            results: [
              { label: 'Curiosity about the topic', count: 1, examples: ['mostly curiosity'] },
              { label: 'Came via social connection', count: 1, examples: ['a friend invited me'] }
            ]
          }
        },
        messageType: 'json',
        channels: [moderatorChannel]
      }
    ])
  })

  test('derives count/examples from matchingAnswers rather than trusting the model, dropping out-of-range references', async () => {
    mockFindMessagesFor({ prompts: [promptMessage], answers: [answerMessageOne, answerMessageTwo] })
    mockGetChatPromptResponse.mockResolvedValue({
      themes: [
        // Claims 3 matches (including a duplicate and an out-of-range index 5) — only answer 1 is valid.
        { value: 'Inflated theme', matchingAnswers: [1, 1, 5] },
        // Entirely out-of-range — should be dropped rather than reported with a fabricated count.
        { value: 'Hallucinated theme', matchingAnswers: [9] }
      ]
    })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    const [{ message }] = result as { message: { questionResults: { results: { label: string; count: number }[] } } }[]
    expect(message.questionResults.results).toEqual([{ label: 'Inflated theme', count: 1, examples: ['mostly curiosity'] }])
  })

  test('tallies votes for a singleChoice question without calling the LLM', async () => {
    const yesAnswer = { _id: 'answer-1', body: 'yes', bodyType: 'text', answersPrompt: 'prompt-1' }
    const noAnswer = { _id: 'answer-2', body: 'no', bodyType: 'text', answersPrompt: 'prompt-1' }
    const secondYesAnswer = { _id: 'answer-3', body: 'yes', bodyType: 'text', answersPrompt: 'prompt-1' }
    mockFindMessagesFor({ prompts: [singleChoicePromptMessage], answers: [yesAnswer, noAnswer, secondYesAnswer] })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(result).toEqual([
      {
        visible: true,
        message: {
          type: 'questionResults',
          timestamp: expect.objectContaining({ start: expectedWindowStart, end: expect.any(Number) }),
          questionResults: {
            questionType: 'warmUpQuestion',
            question: 'Have you attended one of these before?',
            format: 'singleChoice',
            results: [
              { label: 'Yes', count: 2 },
              { label: 'No', count: 1 }
            ]
          }
        },
        messageType: 'json',
        channels: [moderatorChannel]
      }
    ])
  })

  test('returns [] for a singleChoice question with no matching votes', async () => {
    const stalePromptMessage = { ...singleChoicePromptMessage, _id: 'prompt-2' }
    const unrelatedAnswer = { _id: 'answer-1', body: 'maybe', bodyType: 'text', answersPrompt: 'prompt-2' }
    mockFindMessagesFor({ prompts: [stalePromptMessage], answers: [unrelatedAnswer] })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
  })

  test('returns [] if the LLM call throws', async () => {
    mockFindMessagesFor({ prompts: [promptMessage], answers: [answerMessageOne, answerMessageTwo] })
    mockGetChatPromptResponse.mockRejectedValue(new Error('boom'))
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
  })

  test('returns [] when the model reports no themes', async () => {
    mockFindMessagesFor({ prompts: [promptMessage], answers: [answerMessageOne, answerMessageTwo] })
    mockGetChatPromptResponse.mockResolvedValue({ themes: [] })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
  })

  test('caps themes at MAX_WARM_UP_THEMES, merging the least-supported into an Other bucket', async () => {
    // 7 themes with strictly decreasing counts (5, 4, 3, 2, 1, 1, 1), well past the 5-theme cap.
    // The top 4 (a-d) have unambiguous, distinct counts; e/f/g (1 answer each) are the overflow.
    const answers = Array.from({ length: 17 }, (_, i) => ({
      _id: `answer-${i + 1}`,
      body: `answer text ${i + 1}`,
      bodyType: 'text',
      answersPrompt: 'prompt-1'
    }))
    mockFindMessagesFor({ prompts: [promptMessage], answers })
    mockGetChatPromptResponse.mockResolvedValue({
      themes: [
        { value: 'theme a', matchingAnswers: [1, 2, 3, 4, 5] },
        { value: 'theme b', matchingAnswers: [6, 7, 8, 9] },
        { value: 'theme c', matchingAnswers: [10, 11, 12] },
        { value: 'theme d', matchingAnswers: [13, 14] },
        { value: 'theme e', matchingAnswers: [15] },
        { value: 'theme f', matchingAnswers: [16] },
        { value: 'theme g', matchingAnswers: [17] }
      ]
    })
    const context = buildContext()

    const result = await moderatorNotifier.onConversationEvent.call(context, startedEvent())

    const [{ message }] = result as { message: { questionResults: { results: QuestionResultSummary[] } } }[]
    expect(message.questionResults.results).toEqual([
      { label: 'theme a', count: 5, examples: ['answer text 1', 'answer text 2', 'answer text 3'] },
      { label: 'theme b', count: 4, examples: ['answer text 6', 'answer text 7', 'answer text 8'] },
      { label: 'theme c', count: 3, examples: ['answer text 10', 'answer text 11', 'answer text 12'] },
      { label: 'theme d', count: 2, examples: ['answer text 13', 'answer text 14'] },
      {
        label: 'Other',
        count: 3,
        examples: ['answer text 15', 'answer text 16', 'answer text 17']
      }
    ])
  })
})
