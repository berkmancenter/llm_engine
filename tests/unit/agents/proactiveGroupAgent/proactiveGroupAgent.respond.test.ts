import { jest } from '@jest/globals'

/* Covers the two gating layers in proactiveGroupAgent.respond() — rate limiting and
   safetyPosture-gated professionalism validation — without making any LLM calls.
   runInterventionAnalysis and validateProfessionalism are mocked so behaviour is deterministic. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunInterventionAnalysis = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockValidateProfessionalism = jest.fn<(...args: any[]) => Promise<boolean>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFn = () => jest.fn<(...args: any[]) => any>()

jest.unstable_mockModule('../src/agents/helpers/interventionHandler.js', () => ({
  runInterventionAnalysis: mockRunInterventionAnalysis,
  detectPrivateInterventionOpportunity: mockFn(),
  buildInterventionTypeSection: mockFn(),
  interventionLlmTemplateVars: { system: [], user: [] },
  USER_TEMPLATE: ''
}))

jest.unstable_mockModule('../src/agents/helpers/professionalismValidator.js', () => ({
  default: mockValidateProfessionalism
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetTranscript = jest.fn<(...args: any[]) => string>().mockReturnValue('')

jest.unstable_mockModule('../src/agents/helpers/transcript.js', () => ({
  default: {
    getTranscript: mockGetTranscript,
    searchTranscript: mockFn().mockResolvedValue({ chunks: '' }),
    loadEventMetadataIntoVectorStore: mockFn().mockResolvedValue(undefined),
    deleteTranscript: mockFn().mockResolvedValue(undefined)
  }
}))

const { default: proactiveGroupAgent } = await import('../../../../src/agents/proactiveGroupAgent/proactiveGroupAgent.js')

// ── helpers ────────────────────────────────────────────────────────────────────

const AGENT_NAME = 'Proactive Group Agent'

function makeMessage(overrides: {
  fromAgent?: boolean
  visible?: boolean
  pseudonym?: string
  createdAt?: Date
  channels?: string[]
}) {
  const createdAt = overrides.createdAt ?? new Date()
  return {
    fromAgent: false,
    visible: true,
    pseudonym: 'Some User',
    channels: ['chat'],
    body: 'hello',
    createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function makeAgent(overrides: {
  messages?: ReturnType<typeof makeMessage>[]
  minContributionMinutes?: number
  safetyPosture?: 'standard' | 'strict'
  startTime?: Date
} = {}) {
  const startTime = overrides.startTime ?? new Date(Date.now() - 20 * 60 * 1000) // 20 min ago
  const minContributionMinutes = overrides.minContributionMinutes ?? 2

  return {
    name: AGENT_NAME,
    instanceName: AGENT_NAME,
    agentType: 'proactiveGroupAgent',
    _id: 'test-agent-id',
    agentConfig: { personality: null } as Record<string, unknown>,
    getLLM: mockFn().mockResolvedValue({}),
    conversation: {
      name: 'Test Conversation',
      startTime,
      goals: ['synthesize_discussion'],
      behaviorPolicy: {
        globalPolicy: {
          tone: 'warmSupportive' as const,
          verbosity: 'brief' as const,
          formality: 'semiFormal' as const,
          ...(overrides.safetyPosture ? { safetyPosture: overrides.safetyPosture } : {})
        },
        channels: {
          groupChat: {
            proactivePolicy: {
              initiativeLevel: 'moderatelyProactive' as const,
              minContributionMinutes
            }
          }
        }
      },
      channels: [{ name: 'chat', direct: false }],
      messages: overrides.messages ?? [],
      conversationContext: undefined
    }
  }
}

function makeTranscriptMessage(text: string, offsetMs = 0) {
  const createdAt = new Date(Date.now() - offsetMs)
  return {
    fromAgent: false,
    visible: true,
    pseudonym: 'Speaker',
    channels: ['transcript'],
    body: text,
    bodyType: 'text',
    createdAt,
    updatedAt: createdAt
  }
}

// conversationHistory is the periodic trigger's transcript slice passed into respond
function makeConversationHistory(end = new Date(), messages: ReturnType<typeof makeTranscriptMessage>[] = []) {
  return { start: new Date(end.getTime() - 600_000), end, messages }
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('proactiveGroupAgent', () => {
  describe('default configuration', () => {
    it('has the expected name and description', () => {
      expect(proactiveGroupAgent.name).toBe('Proactive Group Agent')
      expect(proactiveGroupAgent.description).toContain('strategic interventions')
    })

    it('defaults to sarcastic-expert personality', () => {
      expect(proactiveGroupAgent.agentConfig?.personality).toBe('sarcastic-expert')
    })

    it('uses a periodic trigger with a 120-second interval', () => {
      expect(proactiveGroupAgent.defaultTriggers?.periodic?.timerPeriod).toBe(120)
    })

    it('defaults to a 10-minute transcript window via agentConfig', () => {
      expect(proactiveGroupAgent.agentConfig?.transcriptWindow).toBe(10)
    })

    it('defaults to an elevated priority for missing_perspective via agentConfig', () => {
      expect((proactiveGroupAgent.agentConfig?.goalPriorities as Record<string, number>)?.missing_perspective).toBe(68)
    })
  })
})

describe('proactiveGroupAgent respond', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('rate limiting', () => {
    it('returns [] and skips LLM when own message is within minContributionMinutes', async () => {
      const now = new Date()
      const recentOwnMessage = makeMessage({
        fromAgent: true,
        visible: true,
        pseudonym: AGENT_NAME,
        createdAt: new Date(now.getTime() - 60 * 1000) // 1 min ago (< 2 min default)
      })
      const agent = makeAgent({ messages: [recentOwnMessage] })

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(responses).toEqual([])
      expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
    })

    it('proceeds past rate limit when own message is outside minContributionMinutes', async () => {
      const now = new Date()
      const oldOwnMessage = makeMessage({
        fromAgent: true,
        visible: true,
        pseudonym: AGENT_NAME,
        createdAt: new Date(now.getTime() - 3 * 60 * 1000) // 3 min ago (> 2 min default)
      })
      const agent = makeAgent({ messages: [oldOwnMessage] })
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(mockRunInterventionAnalysis).toHaveBeenCalled()
    })

    it('does not count other agents\' messages against the rate limit', async () => {
      const now = new Date()
      const otherAgentMessage = makeMessage({
        fromAgent: true,
        visible: true,
        pseudonym: 'Event Assistant', // different agent
        createdAt: new Date(now.getTime() - 30 * 1000) // 30 sec ago — would be rate-limited if counted
      })
      const agent = makeAgent({ messages: [otherAgentMessage] })
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(mockRunInterventionAnalysis).toHaveBeenCalled()
    })

    it('does not count invisible own messages against the rate limit', async () => {
      const now = new Date()
      const invisibleOwnMessage = makeMessage({
        fromAgent: true,
        visible: false, // invisible
        pseudonym: AGENT_NAME,
        createdAt: new Date(now.getTime() - 30 * 1000)
      })
      const agent = makeAgent({ messages: [invisibleOwnMessage] })
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(mockRunInterventionAnalysis).toHaveBeenCalled()
    })

    it('uses startTime as baseline when there are no prior own messages', async () => {
      const now = new Date()
      // startTime was 1 min ago — within the 2 min default interval
      const recentStartTime = new Date(now.getTime() - 60 * 1000)
      const agent = makeAgent({ messages: [], startTime: recentStartTime })

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(responses).toEqual([])
      expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
    })

    it('respects a custom minContributionMinutes from behaviorPolicy', async () => {
      const now = new Date()
      // own message 3 min ago — outside 2 min default but inside custom 5 min
      const ownMessage = makeMessage({
        fromAgent: true,
        visible: true,
        pseudonym: AGENT_NAME,
        createdAt: new Date(now.getTime() - 3 * 60 * 1000)
      })
      const agent = makeAgent({ messages: [ownMessage], minContributionMinutes: 5 })

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(responses).toEqual([])
      expect(mockRunInterventionAnalysis).not.toHaveBeenCalled()
    })
  })

  describe('transcript window', () => {
    it('calls transcript.getTranscript with agentConfig.transcriptWindowSeconds and passes result to runInterventionAnalysis', async () => {
      const now = new Date()
      const agent = makeAgent({ startTime: new Date(now.getTime() - 10 * 60 * 1000) })
      mockGetTranscript.mockReturnValue('Part-time work is the future.')
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(mockGetTranscript).toHaveBeenCalledWith(
        agent.conversation,
        600, // default transcriptWindow (10 min × 60)
        expect.any(Date)
      )
      const callArgs = mockRunInterventionAnalysis.mock.calls[0]
      const recentTranscript = callArgs[callArgs.length - 2] as string
      expect(recentTranscript).toBe('Part-time work is the future.')
    })

    it('respects a custom transcriptWindow in agentConfig', async () => {
      const now = new Date()
      const agent = makeAgent({ startTime: new Date(now.getTime() - 10 * 60 * 1000) })
      agent.agentConfig.transcriptWindow = 5 // 5 minutes
      mockGetTranscript.mockReturnValue('')
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      expect(mockGetTranscript).toHaveBeenCalledWith(agent.conversation, 300, expect.any(Date))
    })
  })

  describe('goal priorities', () => {
    it('passes agentConfig.goalPriorities through to runInterventionAnalysis and into the composed system prompt', async () => {
      const now = new Date()
      const agent = makeAgent({ startTime: new Date(now.getTime() - 20 * 60 * 1000) })
      agent.agentConfig.goalPriorities = { synthesize_discussion: 80 }
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      const callArgs = mockRunInterventionAnalysis.mock.calls[0]
      const goalPriorities = callArgs[callArgs.length - 1]
      expect(goalPriorities).toEqual({ synthesize_discussion: 80 })

      // composeSystemPrompt is not mocked in this file — assert the real prompt it built
      // reflects the priority (tier label rendered for priority >= 67), proving the value
      // actually reached promptComposer and wasn't just threaded to runInterventionAnalysis.
      const systemPrompt = callArgs[1] as string
      expect(systemPrompt).toContain('Preferred pattern')
    })

    it('passes undefined goalPriorities through when agentConfig has none set', async () => {
      const now = new Date()
      const agent = makeAgent({ startTime: new Date(now.getTime() - 20 * 60 * 1000) })
      mockRunInterventionAnalysis.mockResolvedValue(null)

      await proactiveGroupAgent.respond.call(agent, makeConversationHistory(now))

      const callArgs = mockRunInterventionAnalysis.mock.calls[0]
      expect(callArgs[callArgs.length - 1]).toBeUndefined()

      const systemPrompt = callArgs[1] as string
      expect(systemPrompt).not.toContain('Preferred pattern')
    })
  })

  describe('safetyPosture professionalism check', () => {
    const analysisWithMessage = {
      shouldIntervene: true,
      goalId: 'synthesize_discussion',
      reasoning: 'test',
      sharedChatMessage: 'Let me synthesize what I heard.',
      confidenceScore: 80,
      detectedPattern: 'discussion lull',
      affectedUsers: 3
    }

    function makeUnratelimitedAgent(safetyPosture?: 'standard' | 'strict') {
      // startTime 10 min ago, no messages → well outside any rate limit
      return makeAgent({ messages: [], startTime: new Date(Date.now() - 10 * 60 * 1000), safetyPosture })
    }

    it('does not call validateProfessionalism when safetyPosture is not set', async () => {
      const agent = makeUnratelimitedAgent(undefined)
      mockRunInterventionAnalysis.mockResolvedValue(analysisWithMessage)

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory())

      expect(mockValidateProfessionalism).not.toHaveBeenCalled()
      expect(responses).toHaveLength(1)
    })

    it('does not call validateProfessionalism when safetyPosture is standard', async () => {
      const agent = makeUnratelimitedAgent('standard')
      mockRunInterventionAnalysis.mockResolvedValue(analysisWithMessage)

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory())

      expect(mockValidateProfessionalism).not.toHaveBeenCalled()
      expect(responses).toHaveLength(1)
    })

    it('calls validateProfessionalism and passes through when strict and check passes', async () => {
      const agent = makeUnratelimitedAgent('strict')
      mockRunInterventionAnalysis.mockResolvedValue(analysisWithMessage)
      mockValidateProfessionalism.mockResolvedValue(true)

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory())

      expect(mockValidateProfessionalism).toHaveBeenCalledWith(
        expect.anything(), // llm
        analysisWithMessage.sharedChatMessage,
        agent.conversation.name,
        analysisWithMessage.goalId,
        expect.any(String) // recentTranscript
      )
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBe(analysisWithMessage.sharedChatMessage)
    })

    it('returns [] when strict and professionalism check fails', async () => {
      const agent = makeUnratelimitedAgent('strict')
      mockRunInterventionAnalysis.mockResolvedValue(analysisWithMessage)
      mockValidateProfessionalism.mockResolvedValue(false)

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory())

      expect(mockValidateProfessionalism).toHaveBeenCalled()
      expect(responses).toEqual([])
    })

    it('skips validateProfessionalism when analysis has no sharedChatMessage', async () => {
      const agent = makeUnratelimitedAgent('strict')
      mockRunInterventionAnalysis.mockResolvedValue({
        ...analysisWithMessage,
        sharedChatMessage: null
      })

      const responses = await proactiveGroupAgent.respond.call(agent, makeConversationHistory())

      expect(mockValidateProfessionalism).not.toHaveBeenCalled()
      expect(responses).toEqual([])
    })
  })
})
