import {
  getInterventionAnalysisSchema,
  interventionLlmTemplateVars,
  USER_TEMPLATE
} from '../../../src/agents/helpers/interventionHandler.js'
import { InterventionType } from '../../../src/agents/helpers/interventionTypes.js'

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
      expect(InterventionType.MODERATOR_ESCALATION).toBe('MODERATOR_ESCALATION')
      expect(InterventionType.NONE).toBe('NONE')
    })
  })

  describe('getInterventionAnalysisSchema', () => {
    const allInterventions = Object.values(InterventionType)
    const schema = getInterventionAnalysisSchema(allInterventions, true)

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

    it('validates moderator escalation type', () => {
      const validAnalysis = {
        shouldIntervene: true,
        interventionType: 'MODERATOR_ESCALATION',
        reasoning: 'Strong recurring theme needs moderator attention',
        sharedChatMessage: "I've flagged a question to the moderator",
        moderatorMessage:
          'Multiple participants asking about regulatory changes. Suggested question: How do recent regulatory shifts affect adoption?',
        confidenceScore: 90,
        detectedPattern: 'Regulatory concerns',
        affectedUsers: 6
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
        'MODERATOR_ESCALATION',
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
      const limitedSchema = getInterventionAnalysisSchema(engagementOnly, false)

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

    it('includes moderatorMessage field when supportsModerator is true', () => {
      const schemaWithModerator = getInterventionAnalysisSchema(allInterventions, true)

      const analysisWithModeratorMessage = {
        shouldIntervene: true,
        interventionType: 'MODERATOR_ESCALATION',
        reasoning: 'Test',
        moderatorMessage: 'Test moderator message',
        confidenceScore: 75
      }

      const result = schemaWithModerator.safeParse(analysisWithModeratorMessage)
      expect(result.success).toBe(true)
    })

    it('schema works without moderatorMessage field when supportsModerator is false', () => {
      const schemaWithoutModerator = getInterventionAnalysisSchema(
        [InterventionType.PROVOCATION, InterventionType.NONE],
        false
      )

      const analysisWithoutModeratorMessage = {
        shouldIntervene: true,
        interventionType: 'PROVOCATION',
        reasoning: 'Test',
        confidenceScore: 75
      }

      const result = schemaWithoutModerator.safeParse(analysisWithoutModeratorMessage)
      expect(result.success).toBe(true)
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
      expect(varNames).toContain('moderatorContext')
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
      expect(USER_TEMPLATE).toContain('## Moderator Context:')
      expect(USER_TEMPLATE).toContain('## Your Recent Posts:')
    })

    it('includes all template variable placeholders', () => {
      expect(USER_TEMPLATE).toContain('{topic}')
      expect(USER_TEMPLATE).toContain('{recentTranscript}')
      expect(USER_TEMPLATE).toContain('{retrievedChunks}')
      expect(USER_TEMPLATE).toContain('{privateMessages}')
      expect(USER_TEMPLATE).toContain('{sharedChatHistory}')
      expect(USER_TEMPLATE).toContain('{moderatorContext}')
      expect(USER_TEMPLATE).toContain('{agentRecentPosts}')
    })
  })
})
