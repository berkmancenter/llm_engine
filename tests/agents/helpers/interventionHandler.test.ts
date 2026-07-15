import { jest } from '@jest/globals'
import setupIntTest from '../../utils/setupIntTest.js'

// Mocks registered before dynamic import so the LLM and transcript are never hit in unit tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetTranscript = jest.fn<(...args: any[]) => string>().mockReturnValue('transcript text')

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

jest.unstable_mockModule('../src/agents/helpers/transcript.js', () => ({
  default: {
    getTranscript: mockGetTranscript,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    searchTranscript: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ chunks: '' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadEventMetadataIntoVectorStore: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteTranscript: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined)
  }
}))

const {
  interventionLlmTemplateVars,
  USER_TEMPLATE,
  buildInterventionTypeSection,
  runInterventionAnalysis,
  detectPrivateInterventionOpportunity
} = await import('../../../src/agents/helpers/interventionHandler.js')

setupIntTest()

describe('interventionHandler', () => {
  describe('interventionLlmTemplateVars', () => {
    it('defines expected template variables', () => {
      expect(interventionLlmTemplateVars).toBeDefined()
      expect(interventionLlmTemplateVars.system).toEqual([])
      expect(interventionLlmTemplateVars.user).toBeDefined()
    })

    it('template vars define expected user variables', () => {
      const userVars = interventionLlmTemplateVars.user
      expect(userVars).toBeDefined()
      expect(Array.isArray(userVars)).toBe(true)

      const varNames = userVars.map((v) => v.name)
      expect(varNames).toContain('topic')
      expect(varNames).toContain('recentTranscript')
      expect(varNames).toContain('retrievedChunks')
      expect(varNames).toContain('privateMessages')
      expect(varNames).toContain('sharedChatHistory')
      expect(varNames).toContain('agentRecentPosts')
    })
  })

  describe('USER_TEMPLATE', () => {
    it('includes all required context sections', () => {
      expect(USER_TEMPLATE).toContain('## Event Topic:')
      expect(USER_TEMPLATE).toContain('## Recent Transcript')
      expect(USER_TEMPLATE).toContain('## Retrieved Relevant Context')
      expect(USER_TEMPLATE).toContain('## Private Messages')
      expect(USER_TEMPLATE).toContain('## Shared Chat History:')
      expect(USER_TEMPLATE).toContain('## Your Recent Posts:')
    })

    it('includes all template variable placeholders', () => {
      expect(USER_TEMPLATE).toContain('{topic}')
      expect(USER_TEMPLATE).toContain('{recentTranscript}')
      expect(USER_TEMPLATE).toContain('{retrievedChunks}')
      expect(USER_TEMPLATE).toContain('{privateMessages}')
      expect(USER_TEMPLATE).toContain('{sharedChatHistory}')
      expect(USER_TEMPLATE).toContain('{agentRecentPosts}')
    })
  })

  describe('runInterventionAnalysis', () => {
    it('is exported as a function', () => {
      expect(typeof runInterventionAnalysis).toBe('function')
    })
  })

  describe('buildInterventionTypeSection', () => {
    const exampleInfo = {
      description: 'A warm check-in message',
      register: 'warm',
      examples: ['How are you finding the discussion?', 'Anything you want to share?']
    }

    it('returns empty string for NONE type', () => {
      expect(buildInterventionTypeSection('NONE', exampleInfo)).toBe('')
    })

    it('includes the intervention type and description in the header', () => {
      const result = buildInterventionTypeSection('CHECKIN', exampleInfo)
      expect(result).toContain('### CHECKIN')
      expect(result).toContain('A warm check-in message')
    })

    it('includes the register', () => {
      const result = buildInterventionTypeSection('CHECKIN', exampleInfo)
      expect(result).toContain('[warm]')
    })

    it('includes all examples', () => {
      const result = buildInterventionTypeSection('CHECKIN', exampleInfo)
      expect(result).toContain('How are you finding the discussion?')
      expect(result).toContain('Anything you want to share?')
    })
  })

  describe('detectPrivateInterventionOpportunity rate limiting', () => {
    const startTime = new Date(Date.now() - 20 * 60 * 1000) // 20 min ago

    function makeContext(agentConfig = {}) {
      return {
        name: 'Test Agent',
        agentType: 'eventAssistant',
        _id: 'test-agent-id',
        agentConfig,
        conversation: {
          name: 'Test Conversation',
          startTime,
          channels: []
        }
      }
    }

    function makeDmHistory(messages: { fromAgent: boolean; visible: boolean; createdAt: Date }[]) {
      return {
        end: new Date(),
        messages: messages.map((m) => ({ ...m, body: 'hello', pseudonym: 'Agent' }))
      }
    }

    const emptyHistory = { end: new Date(), messages: [] }
    const schema = { parse: jest.fn() } as unknown as import('zod').ZodSchema // not reached in rate-limited path

    it('returns null when a visible agent message is within the default interval', async () => {
      const now = new Date()
      const dmHistory = makeDmHistory([
        { fromAgent: true, visible: true, createdAt: new Date(now.getTime() - 60 * 1000) } // 1 min ago < 2 min default
      ])

      const result = await detectPrivateInterventionOpportunity.call(
        makeContext(),
        { end: now, messages: [] },
        'system prompt',
        schema,
        emptyHistory,
        dmHistory
      )

      expect(result).toBeNull()
    })

    it('does not count invisible agent messages against the rate limit', async () => {
      const now = new Date()
      // invisible message 30s ago would rate-limit if counted, but should be ignored
      const dmHistory = makeDmHistory([{ fromAgent: true, visible: false, createdAt: new Date(now.getTime() - 30 * 1000) }])
      // startTime 20 min ago → well outside default 2 min → should proceed
      const ctx = makeContext()

      // Will reach runInterventionAnalysis — mock returns undefined → code throws accessing properties
      const resultPromise = detectPrivateInterventionOpportunity.call(
        ctx,
        { end: now, messages: [] },
        'system prompt',
        schema,
        emptyHistory,
        dmHistory
      )

      await expect(resultPromise).rejects.toThrow()
    })

    it('uses startTime as baseline when participant has no prior agent messages', async () => {
      const now = new Date()
      // startTime is 1 min ago — within the 2 min default interval
      const recentStartTime = new Date(now.getTime() - 60 * 1000)
      const ctx = { ...makeContext(), conversation: { ...makeContext().conversation, startTime: recentStartTime } }

      const result = await detectPrivateInterventionOpportunity.call(
        ctx,
        { end: now, messages: [] },
        'system prompt',
        schema,
        emptyHistory,
        { end: now, messages: [] } // no prior agent messages
      )

      expect(result).toBeNull()
    })

    it('respects a custom minContributionMinutes from behaviorPolicy', async () => {
      const now = new Date()
      // agent message 3 min ago — outside 2 min default but inside custom 5 min
      const dmHistory = makeDmHistory([
        { fromAgent: true, visible: true, createdAt: new Date(now.getTime() - 3 * 60 * 1000) }
      ])
      const behaviorPolicy = {
        channels: { dm: { proactivePolicy: { initiativeLevel: 'lightlyProactive' as const, minContributionMinutes: 5 } } }
      }

      const result = await detectPrivateInterventionOpportunity.call(
        makeContext(),
        { end: now, messages: [] },
        'system prompt',
        schema,
        emptyHistory,
        dmHistory,
        undefined,
        undefined,
        undefined, // activeGoals
        behaviorPolicy
      )

      expect(result).toBeNull()
    })
  })

  describe('runInterventionAnalysis confidence thresholds', () => {
    function makeContext() {
      return {
        name: 'Test Agent',
        agentType: 'proactiveGroupAgent',
        _id: 'test-agent-id',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getLLM: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}),
        llmTemplates: { user: undefined },
        conversation: {
          name: 'Test Conversation',
          startTime: new Date(Date.now() - 20 * 60 * 1000),
          channels: [] // no direct channels → dmChannels is [], populate loop is skipped
        }
      }
    }

    function makeAnalysis(overrides: { shouldIntervene?: boolean; confidenceScore?: number } = {}) {
      return {
        shouldIntervene: true,
        reasoning: 'test reasoning',
        sharedChatMessage: 'A group message.',
        detectedPattern: 'discussion lull',
        affectedUsers: 3,
        confidenceScore: 70,
        goalId: 'synthesize_discussion',
        ...overrides
      }
    }

    const sharedChatHistory = { end: new Date(), messages: [] }
    const schema = { parse: jest.fn() } as unknown as import('zod').ZodSchema

    beforeEach(() => {
      jest.clearAllMocks()
    })

    it('returns null when shouldIntervene is false', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ shouldIntervene: false, confidenceScore: 90 }))

      const result = await runInterventionAnalysis.call(makeContext(), sharedChatHistory, 'system', schema, null, undefined)

      expect(result).toBeNull()
    })

    it('returns null when confidence is below the default threshold of 60', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 59 }))

      const result = await runInterventionAnalysis.call(makeContext(), sharedChatHistory, 'system', schema, null, undefined)

      expect(result).toBeNull()
    })

    it('returns analysis when confidence meets the default threshold of 60', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 60 }))

      const result = await runInterventionAnalysis.call(makeContext(), sharedChatHistory, 'system', schema, null, undefined)

      expect(result).not.toBeNull()
      expect(result!.confidenceScore).toBe(60)
    })

    it('returns null when socialSensitivity is high and confidence is below 75', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 70 }))
      const behaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { initiativeLevel: 'moderatelyProactive' as const, socialSensitivity: 'high' as const } } }
      }

      const result = await runInterventionAnalysis.call(
        makeContext(),
        sharedChatHistory,
        'system',
        schema,
        null,
        undefined,
        undefined, // extraTemplateVars
        undefined, // activeGoals
        behaviorPolicy
      )

      expect(result).toBeNull()
    })

    it('returns analysis when socialSensitivity is high and confidence meets the 75 threshold', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 75 }))
      const behaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { initiativeLevel: 'moderatelyProactive' as const, socialSensitivity: 'high' as const } } }
      }

      const result = await runInterventionAnalysis.call(
        makeContext(),
        sharedChatHistory,
        'system',
        schema,
        null,
        undefined,
        undefined, // extraTemplateVars
        undefined, // activeGoals
        behaviorPolicy
      )

      expect(result).not.toBeNull()
    })

    it('returns null when confidence is below the goal minConfidence floor', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 70 }))
      const activeGoals = [{ triggers: { minConfidence: 80 } }] as import('../../../src/types/index.types.js').ConversationGoal[]

      const result = await runInterventionAnalysis.call(
        makeContext(),
        sharedChatHistory,
        'system',
        schema,
        null,
        undefined,
        undefined, // extraTemplateVars
        activeGoals
      )

      expect(result).toBeNull()
    })

    it('uses the higher of policyThreshold and patternFloor as the effective threshold', async () => {
      // policy threshold = 75 (high sensitivity), patternFloor = 65 → effective = 75
      // confidence 70 is below 75 → null
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 70 }))
      const behaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { initiativeLevel: 'moderatelyProactive' as const, socialSensitivity: 'high' as const } } }
      }
      const activeGoals = [{ triggers: { minConfidence: 65 } }] as import('../../../src/types/index.types.js').ConversationGoal[]

      const result = await runInterventionAnalysis.call(
        makeContext(),
        sharedChatHistory,
        'system',
        schema,
        null,
        undefined,
        undefined, // extraTemplateVars
        activeGoals,
        behaviorPolicy
      )

      expect(result).toBeNull()
    })

    it('uses the patternFloor when it exceeds the policy threshold', async () => {
      // policy threshold = 60 (default), patternFloor = 80 → effective = 80
      // confidence 75 is below 80 → null
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 75 }))
      const activeGoals = [{ triggers: { minConfidence: 80 } }] as import('../../../src/types/index.types.js').ConversationGoal[]

      const result = await runInterventionAnalysis.call(
        makeContext(),
        sharedChatHistory,
        'system',
        schema,
        null,
        undefined,
        undefined, // extraTemplateVars
        activeGoals
      )

      expect(result).toBeNull()
    })

    it('returns the analysis when confidence meets the effective threshold', async () => {
      mockGetChatPromptResponse.mockResolvedValue(makeAnalysis({ confidenceScore: 80 }))
      const activeGoals = [{ triggers: { minConfidence: 80 } }] as import('../../../src/types/index.types.js').ConversationGoal[]

      const result = await runInterventionAnalysis.call(
        makeContext(),
        sharedChatHistory,
        'system',
        schema,
        null,
        undefined,
        undefined, // extraTemplateVars
        activeGoals
      )

      expect(result).not.toBeNull()
      expect(result!.confidenceScore).toBe(80)
    })
  })
})
