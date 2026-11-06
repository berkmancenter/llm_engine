import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMessageExists = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMessageFind = jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

jest.unstable_mockModule('../src/models/message.model.js', () => ({
  default: { exists: mockMessageExists, find: mockMessageFind }
}))

// Only findMessages is mocked (it's the one DB call); the rest of messageVisibility.js stays
// real since getConversationHistory calls filterForAudience/hideContextOf directly from it, and
// those are pure given messages with no hiddenByAdmin/flagged fields.
const actualMessageVisibility = await import('../../../../src/utils/messageVisibility.js')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindMessages = jest.fn<(...args: any[]) => Promise<any>>()
jest.unstable_mockModule('../src/utils/messageVisibility.js', () => ({
  ...actualMessageVisibility,
  findMessages: mockFindMessages
}))

// eventQuestionHandler.js transitively needs other llmChain.js exports this test doesn't mock;
// it's unrelated to onConversationEvent, so stub it out entirely, same as voiceAssistant's own
// respond() test does for the same reason.
jest.unstable_mockModule('../src/agents/eventAssistant/eventQuestionHandler.js', () => ({
  eventAssistantLLMTemplates: {},
  eventAssistantLlmTemplateVars: {},
  answerQuestion: jest.fn()
}))

const { default: eventAssistant } = await import('../../../../src/agents/eventAssistant/eventAssistant.js')
const { default: config } = await import('../../../../src/config/config.js')

const conversationId = 'conv-1'
const pregameChannel = { name: 'pregame', direct: false }

function buildContext(
  conversationOverrides: Record<string, unknown> = {},
  agentConfigOverrides: Record<string, unknown> = {}
) {
  return {
    __t: 'Agent',
    _id: 'agent-1',
    pseudonyms: [{ _id: 'pseudonym-1' }],
    agentConfig: { botName: 'Berkie', ...agentConfigOverrides },
    capabilities: { read: [{ type: 'ownConversation' }], write: [{ type: 'ownConversation' }] },
    getLLM: async () => 'fake-llm',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setGeneratedContentIfAbsent: jest.fn<(...args: any[]) => Promise<any>>().mockImplementation((_key, value) => value),
    conversation: {
      _id: conversationId,
      name: 'Where Are All the Aliens?',
      description: 'A talk about the Fermi paradox.',
      presenters: [{ name: 'Dr. Vega', bio: 'Astrobiologist studying exoplanet atmospheres.' }],
      channels: [pregameChannel],
      ...conversationOverrides
    }
  }
}

function countdownEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: 'conversationWindowCountdown' as const,
    conversationId,
    phase: 'preEvent' as const,
    elapsedMs: 60000,
    remainingMs: 240000,
    ...overrides
  }
}

describe('eventAssistant.onConversationEvent — three facts on conversationWindowCountdown', () => {
  beforeEach(() => {
    mockMessageExists.mockResolvedValue(null)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('returns [] for any event type other than conversationWindowCountdown', async () => {
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, { type: 'conversationStopped', conversationId })

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] when the event is about a different conversation', async () => {
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent({ conversationId: 'other-conv' }))

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] for a countdown tick in a phase other than preEvent', async () => {
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent({ phase: 'other' }))

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] when no pregame channel exists on the conversation', async () => {
    const context = buildContext({ channels: [] })

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] when three facts were already posted to the pregame channel', async () => {
    mockMessageExists.mockResolvedValue({ _id: 'existing-message' })
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(mockMessageExists).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: conversationId,
        pseudonymId: 'pseudonym-1',
        channels: 'pregame',
        'body.type': 'threeFacts'
      })
    )
  })

  test('rejects when the agent lacks read access, same as the dispatcher-gated precedent', async () => {
    const context = buildContext()
    context.capabilities = { read: [], write: [] }

    await expect(eventAssistant.onConversationEvent.call(context, countdownEvent())).rejects.toThrow()
  })

  test('builds the three-facts message from presenters/description only and posts it to the pregame channel', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      facts: ['Fact one', 'Fact two', 'Fact three'],
      invitation: 'Say hello below, we are just getting started.'
    })
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(mockGetChatPromptResponse).toHaveBeenCalledTimes(1)
    const [, , userPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(userPrompt).toContain('Dr. Vega')
    expect(userPrompt).toContain('Astrobiologist studying exoplanet atmospheres.')
    expect(userPrompt).toContain('A talk about the Fermi paradox.')

    expect(result).toEqual([
      {
        message: {
          type: 'threeFacts',
          facts: ['Fact one', 'Fact two', 'Fact three'],
          invitation: 'Say hello below, we are just getting started.'
        },
        messageType: 'json',
        channels: [pregameChannel],
        visible: true
      }
    ])
  })

  test('returns [] when the structured response has no facts', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ facts: [], invitation: 'Say hello!' })
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toEqual([])
  })

  test('tells the model to look for context signals in the description when conversationContext is empty', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ facts: ['Fact one', 'Fact two', 'Fact three'], invitation: 'Say hello!' })
    const context = buildContext()

    await eventAssistant.onConversationEvent.call(context, countdownEvent())

    const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toContain('is often not filled in yet')
    expect(systemPrompt).toContain('use whatever it actually says')
  })

  test('addresses the room generally rather than a single attendee', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ facts: ['Fact one', 'Fact two', 'Fact three'], invitation: 'Say hello!' })
    const context = buildContext()

    await eventAssistant.onConversationEvent.call(context, countdownEvent())

    const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toContain('not sent to a single attendee')
  })

  test('includes the configured personality in the system prompt, so the facts match the rest of the agent', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ facts: ['Fact one', 'Fact two', 'Fact three'], invitation: 'Say hello!' })
    const context = buildContext({}, { personality: 'sarcastic-expert' })

    await eventAssistant.onConversationEvent.call(context, countdownEvent())

    const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toContain('mildly amused')
  })

  test('omits any personality section when none is configured', async () => {
    // Deterministic regardless of the environment's own ENABLE_AGENT_PERSONALITY setting —
    // buildThreeFactsMessage falls back to that global default exactly like buildDmIntroMessage
    // does, so this test pins it off rather than assuming what .env happens to have.
    const originalEnableAgentPersonality = config.enableAgentPersonality
    config.enableAgentPersonality = false
    mockGetChatPromptResponse.mockResolvedValue({ facts: ['Fact one', 'Fact two', 'Fact three'], invitation: 'Say hello!' })
    const context = buildContext()

    try {
      await eventAssistant.onConversationEvent.call(context, countdownEvent())

      const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
      expect(systemPrompt).not.toContain('mildly amused')
    } finally {
      config.enableAgentPersonality = originalEnableAgentPersonality
    }
  })

  test('returns [] if the LLM call throws', async () => {
    mockGetChatPromptResponse.mockRejectedValue(new Error('boom'))
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toEqual([])
  })
})

describe('eventAssistant.onConversationEvent — warm-up question', () => {
  const dmChannel = { name: 'direct-user-1-agent-1', direct: true, participants: ['agent-1'] }

  beforeEach(() => {
    // Three facts' own dedup always reports "already posted" here so its LLM call never mixes
    // into these warm-up-focused assertions; only the warm-up check varies per test.
    mockMessageExists.mockImplementation((query) =>
      Promise.resolve(query['body.type'] === 'threeFacts' ? { _id: 'already-posted' } : null)
    )
    // Default: no channel has a warm-up message yet. sendWarmUpQuestionsToNewJoiners batches its
    // already-sent check into Message.find(...).select(...).lean() — see eventAssistant.ts.
    mockMessageFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('conversationWindowOpened eagerly generates and caches the warm-up question', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ question: 'What brought you here?' })
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, {
      type: 'conversationWindowOpened',
      conversationId,
      phase: 'preEvent'
    })

    expect(result).toEqual([])
    expect(context.setGeneratedContentIfAbsent).toHaveBeenCalledWith('warmUpQuestion', { text: 'What brought you here?' })
  })

  test('conversationWindowOpened returns [] for a phase other than preEvent, without generating', async () => {
    const context = buildContext()

    const result = await eventAssistant.onConversationEvent.call(context, {
      type: 'conversationWindowOpened',
      conversationId,
      phase: 'other'
    })

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('conversationWindowOpened skips generation when the question is organizer-supplied', async () => {
    const context = buildContext({}, { warmUpQuestion: { source: 'organizer', text: 'Hi' } })

    await eventAssistant.onConversationEvent.call(context, {
      type: 'conversationWindowOpened',
      conversationId,
      phase: 'preEvent'
    })

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(context.setGeneratedContentIfAbsent).not.toHaveBeenCalled()
  })

  test('sends the warm-up question to a joined participant on the countdown tick', async () => {
    mockGetChatPromptResponse.mockResolvedValue({ question: 'What brought you here?' })
    const context = buildContext({ channels: [pregameChannel, dmChannel] })

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toEqual([
      {
        message: { text: 'What brought you here?', type: 'warmUpQuestion' },
        messageType: 'json',
        channels: [dmChannel],
        visible: true,
        replyFormat: { type: 'text' }
      }
    ])
  })

  test('does not resend to a channel that already has a warm-up message', async () => {
    mockMessageFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ channels: [dmChannel.name] }]) }) })
    const context = buildContext({ channels: [pregameChannel, dmChannel] })

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('uses the organizer-supplied question and options when configured, without an LLM call', async () => {
    const context = buildContext(
      { channels: [pregameChannel, dmChannel] },
      { warmUpQuestion: { source: 'organizer', format: 'singleChoice', text: 'Hi there', options: ['A', 'B'] } }
    )

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
    expect(result).toEqual([
      {
        message: { text: 'Hi there', type: 'warmUpQuestion' },
        messageType: 'json',
        channels: [dmChannel],
        visible: true,
        replyFormat: {
          type: 'singleChoice',
          options: [
            { value: 'A', label: 'A' },
            { value: 'B', label: 'B' }
          ]
        }
      }
    ])
  })

  test('combines a pending three-facts post and a new joiner warm-up in the same tick', async () => {
    mockMessageExists.mockResolvedValue(null)
    mockGetChatPromptResponse
      .mockResolvedValueOnce({ facts: ['Fact one', 'Fact two', 'Fact three'], invitation: 'Say hello!' })
      .mockResolvedValueOnce({ question: 'What brought you here?' })
    const context = buildContext({ channels: [pregameChannel, dmChannel] })

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toHaveLength(2)
    expect((result[0].message as { type: string }).type).toBe('threeFacts')
    expect((result[1].message as { type: string }).type).toBe('warmUpQuestion')
  })

  test('one channel failing to build its warm-up message does not block the others', async () => {
    const dmChannelTwo = { name: 'direct-user-2-agent-1', direct: true, participants: ['agent-1'] }
    const context = buildContext({ channels: [pregameChannel, dmChannel, dmChannelTwo] })
    mockGetChatPromptResponse
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ question: 'What brought you here?' })

    const result = await eventAssistant.onConversationEvent.call(context, countdownEvent())

    expect(result).toHaveLength(1)
    expect(result[0].channels).toEqual([dmChannelTwo])
  })
})

describe('eventAssistant.onConversationEvent — pregame recap on conversationStarted', () => {
  const chatChannel = { name: 'chat', direct: false }
  const dmChannel = { name: 'direct-user-1-agent-1', direct: true, participants: ['agent-1'] }

  const pregameMessage = {
    _id: 'pm-1',
    body: 'hey, excited for this one',
    bodyType: 'text',
    channels: ['pregame'],
    fromAgent: false,
    pseudonym: 'Curious Badger',
    updatedAt: new Date(),
    createdAt: new Date()
  }
  const promptMessage = {
    _id: 'prompt-1',
    body: { type: 'warmUpQuestion', text: 'What brought you here?' },
    bodyType: 'json',
    channels: [dmChannel.name],
    fromAgent: true,
    pseudonymId: 'pseudonym-1'
  }
  const answerMessage = {
    _id: 'answer-1',
    body: 'mostly curiosity',
    bodyType: 'text',
    channels: [dmChannel.name],
    fromAgent: false,
    pseudonymId: 'attendee-1',
    answersPrompt: 'prompt-1',
    updatedAt: new Date(),
    createdAt: new Date()
  }
  const answerMessageTwo = {
    _id: 'answer-2',
    body: 'a friend invited me',
    bodyType: 'text',
    channels: [dmChannel.name],
    fromAgent: false,
    pseudonymId: 'attendee-2',
    answersPrompt: 'prompt-1',
    updatedAt: new Date(),
    createdAt: new Date()
  }

  function startedEvent(overrides: Record<string, unknown> = {}) {
    return { type: 'conversationStarted' as const, conversationId, topicId: 'topic-1', ...overrides }
  }

  function mockFindMessagesFor({ pregame = [] as unknown[], prompts = [] as unknown[], answers = [] as unknown[] } = {}) {
    mockFindMessages.mockImplementation((_convId: unknown, _audience: unknown, filter: Record<string, unknown>) => {
      if (filter.channels === 'pregame') return Promise.resolve(pregame)
      if (filter['body.type'] === 'warmUpQuestion') return Promise.resolve(prompts)
      if (filter.answersPrompt) return Promise.resolve(answers)
      return Promise.resolve([])
    })
  }

  beforeEach(() => {
    mockFindMessages.mockReset()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('returns [] for any event type other than conversationStarted (sanity check)', async () => {
    const context = buildContext({ channels: [chatChannel], startTime: new Date(), preEventMinutes: 15 })
    const result = await eventAssistant.onConversationEvent.call(context, { type: 'conversationStopped', conversationId })
    expect(result).toEqual([])
  })

  test('rejects when the agent lacks read access, same as the dispatcher-gated precedent', async () => {
    const context = buildContext({ channels: [chatChannel], startTime: new Date(), preEventMinutes: 15 })
    context.capabilities = { read: [], write: [] }

    await expect(eventAssistant.onConversationEvent.call(context, startedEvent())).rejects.toThrow()
  })

  test('returns [] without querying the database when no pre-event window was ever configured', async () => {
    mockFindMessagesFor({ pregame: [pregameMessage] })
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date() })

    const result = await eventAssistant.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockFindMessages).not.toHaveBeenCalled()
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] when no live group channel exists on the conversation', async () => {
    mockFindMessagesFor({})
    const context = buildContext({ channels: [], startTime: new Date(), preEventMinutes: 15 })

    const result = await eventAssistant.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('returns [] without calling the LLM when there is no pregame chat and no warm-up answers', async () => {
    mockFindMessagesFor({})
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date(), preEventMinutes: 15 })

    const result = await eventAssistant.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
    expect(mockGetChatPromptResponse).not.toHaveBeenCalled()
  })

  test('posts a recap built from pregame chat and warm-up answers to the live (chat) channel', async () => {
    mockFindMessagesFor({
      pregame: [pregameMessage],
      prompts: [promptMessage],
      answers: [answerMessage, answerMessageTwo]
    })
    mockGetChatPromptResponse.mockResolvedValue('Welcome back! People were curious, you should have joined sooner.')
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date(), preEventMinutes: 15 })

    const result = await eventAssistant.onConversationEvent.call(context, startedEvent())

    const [, , userPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(userPrompt).toContain('Curious Badger: hey, excited for this one')
    expect(userPrompt).toContain('mostly curiosity')
    expect(userPrompt).toContain('a friend invited me')

    expect(result).toEqual([
      {
        message: { text: 'Welcome back! People were curious, you should have joined sooner.', type: 'pregameRecap' },
        messageType: 'json',
        channels: [chatChannel],
        visible: true
      }
    ])
  })

  test('withholds warm-up answers from the prompt when only one person answered', async () => {
    mockFindMessagesFor({ pregame: [pregameMessage], prompts: [promptMessage], answers: [answerMessage] })
    mockGetChatPromptResponse.mockResolvedValue('Welcome back!')
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date(), preEventMinutes: 15 })

    await eventAssistant.onConversationEvent.call(context, startedEvent())

    const [, , userPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(userPrompt).not.toContain('mostly curiosity')
    expect(userPrompt).toContain('No warm-up answers.')
  })

  test('tells the model not to attribute pregame chat lines to specific pseudonyms', async () => {
    mockFindMessagesFor({ pregame: [pregameMessage] })
    mockGetChatPromptResponse.mockResolvedValue('Welcome back!')
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date(), preEventMinutes: 15 })

    await eventAssistant.onConversationEvent.call(context, startedEvent())

    const [, systemPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(systemPrompt).toContain('Never attribute a specific line to a')
    expect(systemPrompt).toContain("Revealing pregame turnout isn't the point")
  })

  test('posts a recap from pregame chat alone when there were no warm-up answers', async () => {
    mockFindMessagesFor({ pregame: [pregameMessage] })
    mockGetChatPromptResponse.mockResolvedValue('Welcome back!')
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date(), preEventMinutes: 15 })

    const result = await eventAssistant.onConversationEvent.call(context, startedEvent())

    expect(result).toHaveLength(1)
    const [, , userPrompt] = mockGetChatPromptResponse.mock.calls[0]
    expect(userPrompt).toContain('No warm-up answers.')
  })

  test('returns [] if the LLM call throws', async () => {
    mockFindMessagesFor({ pregame: [pregameMessage] })
    mockGetChatPromptResponse.mockRejectedValue(new Error('boom'))
    const context = buildContext({ channels: [chatChannel, dmChannel], startTime: new Date(), preEventMinutes: 15 })

    const result = await eventAssistant.onConversationEvent.call(context, startedEvent())

    expect(result).toEqual([])
  })
})
