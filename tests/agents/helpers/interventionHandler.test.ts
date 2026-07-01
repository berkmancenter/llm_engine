import mongoose from 'mongoose'
import {
  getInterventionAnalysisSchema,
  interventionLlmTemplateVars,
  USER_TEMPLATE,
  proactiveRaceGuard
} from '../../../src/agents/helpers/interventionHandler.js'
import { InterventionType } from '../../../src/agents/helpers/interventionTypes.js'
import Message from '../../../src/models/message.model.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

describe('interventionHandler', () => {
  describe('InterventionType enum', () => {
    it('defines all expected intervention types', () => {
      expect(InterventionType.SIGNAL).toBe('SIGNAL')
      expect(InterventionType.SYNTHESIS).toBe('SYNTHESIS')
      expect(InterventionType.MINORITY_VOICE).toBe('MINORITY_VOICE')
      expect(InterventionType.CONFUSION).toBe('CONFUSION')
      expect(InterventionType.PROVOCATION).toBe('PROVOCATION')
      expect(InterventionType.BRIDGE).toBe('BRIDGE')
      expect(InterventionType.STRUCTURE).toBe('STRUCTURE')
      expect(InterventionType.PLAY).toBe('PLAY')
      expect(InterventionType.NONE).toBe('NONE')
    })
  })

  describe('getInterventionAnalysisSchema', () => {
    const allInterventions = Object.values(InterventionType)
    const schema = getInterventionAnalysisSchema(allInterventions)

    it('validates a valid intervention analysis with intervention', () => {
      const validAnalysis = {
        shouldIntervene: true,
        interventionType: 'SIGNAL',
        reasoning: 'Multiple participants asking about the same topic',
        sharedChatMessage: 'Several of you are wondering about X',
        confidenceScore: 85,
        detectedPattern: 'Common question about topic X',
        affectedUsers: 3
      }

      const result = schema.safeParse(validAnalysis)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data).toEqual(validAnalysis)
      }
    })

    it('validates a valid intervention analysis without intervention', () => {
      const validAnalysis = {
        shouldIntervene: false,
        interventionType: 'NONE',
        reasoning: 'No patterns detected, waiting for more signals',
        confidenceScore: 30
      }

      const result = schema.safeParse(validAnalysis)
      expect(result.success).toBe(true)
    })

    it('rejects invalid intervention type', () => {
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'INVALID_TYPE',
        reasoning: 'Test',
        confidenceScore: 50
      }

      const result = schema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    })

    it('rejects missing required fields', () => {
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'SIGNAL'
        // Missing reasoning and confidenceScore
      }

      const result = schema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    })

    it('rejects invalid confidence score range', () => {
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'SIGNAL',
        reasoning: 'Test',
        confidenceScore: 150 // Over 100
      }

      const result = schema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    })

    it('accepts optional fields', () => {
      const minimalAnalysis = {
        shouldIntervene: false,
        interventionType: 'NONE',
        reasoning: 'Nothing happening',
        confidenceScore: 20
      }

      const result = schema.safeParse(minimalAnalysis)
      expect(result.success).toBe(true)
    })

    it('validates all intervention types', () => {
      const interventionTypes = [
        'SIGNAL',
        'SYNTHESIS',
        'MINORITY_VOICE',
        'CONFUSION',
        'PROVOCATION',
        'BRIDGE',
        'STRUCTURE',
        'PLAY',
        'NONE'
      ]

      interventionTypes.forEach((type) => {
        const analysis = {
          shouldIntervene: type !== 'NONE',
          interventionType: type,
          reasoning: `Testing ${type}`,
          confidenceScore: 75
        }

        const result = schema.safeParse(analysis)
        expect(result.success).toBe(true)
      })
    })

    it('only allows enabled intervention types in schema', () => {
      // Create schema with only engagement interventions
      const engagementOnly = [InterventionType.PROVOCATION, InterventionType.PLAY, InterventionType.NONE]
      const limitedSchema = getInterventionAnalysisSchema(engagementOnly)

      // Should accept enabled types
      const validAnalysis = {
        shouldIntervene: true,
        interventionType: 'PROVOCATION',
        reasoning: 'Test',
        confidenceScore: 75
      }
      expect(limitedSchema.safeParse(validAnalysis).success).toBe(true)

      // Should reject disabled types
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'SIGNAL',
        reasoning: 'Test',
        confidenceScore: 75
      }
      expect(limitedSchema.safeParse(invalidAnalysis).success).toBe(false)
    })
  })

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

  describe('proactiveRaceGuard', () => {
    const conversationId = new mongoose.Types.ObjectId()
    const userId = new mongoose.Types.ObjectId()
    const pseudonymId = new mongoose.Types.ObjectId()

    const makeMessage = (overrides = {}) =>
      Message.create({
        body: 'Test intervention',
        bodyType: 'text',
        conversation: conversationId,
        owner: userId,
        pseudonym: 'Test Agent',
        pseudonymId,
        fromAgent: true,
        visible: true,
        channels: ['chat'],
        upVotes: [],
        downVotes: [],
        ...overrides
      })

    it('returns true when a proactive message exists within the window', async () => {
      await makeMessage({ source: { type: 'agent', proactive: true }, createdAt: new Date() })
      expect(await proactiveRaceGuard(conversationId)).toBe(true)
    })

    it('returns false when no proactive message exists', async () => {
      expect(await proactiveRaceGuard(conversationId)).toBe(false)
    })

    it('returns false when proactive message is outside the window', async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)
      await makeMessage({ source: { type: 'agent', proactive: true }, createdAt: twoMinutesAgo })
      expect(await proactiveRaceGuard(conversationId)).toBe(false)
    })

    it('returns false for agent messages without source.proactive (e.g. Q&A agents)', async () => {
      await makeMessage({ source: { type: 'agent' }, createdAt: new Date() })
      expect(await proactiveRaceGuard(conversationId)).toBe(false)
    })

    it('returns false for proactive message on a different conversation', async () => {
      const otherConversationId = new mongoose.Types.ObjectId()
      await makeMessage({ source: { type: 'agent', proactive: true }, conversation: otherConversationId, createdAt: new Date() })
      expect(await proactiveRaceGuard(conversationId)).toBe(false)
    })

    it('returns false for non-visible proactive messages', async () => {
      await makeMessage({ source: { type: 'agent', proactive: true }, visible: false, createdAt: new Date() })
      expect(await proactiveRaceGuard(conversationId)).toBe(false)
    })
  })
})
