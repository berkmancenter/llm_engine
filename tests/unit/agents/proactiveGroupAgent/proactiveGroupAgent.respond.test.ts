import { jest } from '@jest/globals'

/* Covers the two gating layers in proactiveGroupAgent.respond() — rate limiting and
   safetyPosture-gated professionalism validation — without making any LLM calls.
   runInterventionAnalysis and validateProfessionalism are mocked so behaviour is deterministic. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRunInterventionAnalysis = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockValidateProfessionalism = jest.fn<(...args: any[]) => Promise<boolean>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetTranscript = jest.fn<(...args: any[]) => string>().mockReturnValue('recent transcript text')

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
    agentConfig: { personality: null },
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

// conversationHistory is the periodic trigger's transcript history — only .end matters here
function makeConversationHistory(end = new Date()) {
  return { end, messages: [] }
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

    it('uses a periodic transcript trigger with a 120-second interval', () => {
      expect(proactiveGroupAgent.defaultTriggers?.periodic?.timerPeriod).toBe(120)
      expect(proactiveGroupAgent.defaultTriggers?.periodic?.conversationHistorySettings?.channels).toContain('transcript')
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
