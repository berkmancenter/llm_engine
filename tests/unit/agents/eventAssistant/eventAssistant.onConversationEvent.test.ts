import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMessageExists = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

jest.unstable_mockModule('../src/models/message.model.js', () => ({
  default: { exists: mockMessageExists }
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
    mockMessageExists.mockResolvedValue({ _id: 'already-sent' })
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
