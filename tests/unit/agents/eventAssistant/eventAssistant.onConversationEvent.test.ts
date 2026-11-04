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
