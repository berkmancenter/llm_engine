import { InterventionType } from '../../src/agents/eventAssistant/interventionCategories.js'
import {
  getMediatorAnalysisSchema,
  createMediatorTemplates,
  mediatorLlmTemplateVars
} from '../../src/agents/eventAssistant/mediatorHandler.js'

describe('mediatorHandler', () => {
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

  describe('getMediatorAnalysisSchema', () => {
    const allInterventions = Object.values(InterventionType)
    const schema = getMediatorAnalysisSchema(allInterventions, true)

    it('validates a valid mediator analysis with intervention', () => {
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

    it('validates a valid mediator analysis without intervention', () => {
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
      const limitedSchema = getMediatorAnalysisSchema(engagementOnly, false)

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

  describe('createMediatorTemplates', () => {
    it('creates templates with moderator support', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      expect(templates.mediatorSystem).toBeDefined()
      expect(templates.mediatorUser).toBeDefined()
      expect(templates.mediatorSystem).toContain('MODERATOR_ESCALATION')
    })

    it('creates templates without moderator support', () => {
      const templates = createMediatorTemplates({ supportsModerator: false })

      expect(templates.mediatorSystem).toBeDefined()
      expect(templates.mediatorUser).toBeDefined()
      // MODERATOR_ESCALATION should not be in the output format options
      expect(templates.mediatorSystem).not.toMatch(/"MODERATOR_ESCALATION"/)
    })

    it('system template includes core directives', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      // Check for key sections
      expect(templates.mediatorSystem).toContain('## Voice')
      expect(templates.mediatorSystem).toContain('## Rules')
      expect(templates.mediatorSystem).toContain('PRIVACY:')
      expect(templates.mediatorSystem).toContain('JUDGMENT:')
      expect(templates.mediatorSystem).toContain('## Intervention Types')
      expect(templates.mediatorSystem).toContain('## Output Format')
    })

    it('system template describes all intervention types when all enabled', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      expect(templates.mediatorSystem).toContain('SIGNAL')
      expect(templates.mediatorSystem).toContain('SYNTHESIS')
      expect(templates.mediatorSystem).toContain('MINORITY_VOICE')
      expect(templates.mediatorSystem).toContain('CONFUSION')
      expect(templates.mediatorSystem).toContain('PROVOCATION')
      expect(templates.mediatorSystem).toContain('BRIDGE')
      expect(templates.mediatorSystem).toContain('STRUCTURE')
      expect(templates.mediatorSystem).toContain('PLAY')
      expect(templates.mediatorSystem).toContain('MODERATOR_ESCALATION')
    })

    it('user template includes all required context sections', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      expect(templates.mediatorUser).toContain('## Event Topic:')
      expect(templates.mediatorUser).toContain('## Recent Transcript')
      expect(templates.mediatorUser).toContain('## Retrieved Relevant Context')
      expect(templates.mediatorUser).toContain('## Private Messages')
      expect(templates.mediatorUser).toContain('## Shared Chat History:')
      expect(templates.mediatorUser).toContain('## Moderator Context:')
      expect(templates.mediatorUser).toContain('## Your Recent Posts:')
    })
  })

  describe('mediatorLlmTemplateVars', () => {
    it('defines expected template variables', () => {
      expect(mediatorLlmTemplateVars).toBeDefined()
      expect(mediatorLlmTemplateVars.mediatorSystem).toEqual([])
      expect(mediatorLlmTemplateVars.mediatorUser).toBeDefined()
    })

    it('template vars define expected user variables', () => {
      const userVars = mediatorLlmTemplateVars.mediatorUser
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

  describe('privacy constraints in prompt', () => {
    it('emphasizes privacy protection in system prompt', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      // Check for privacy-related constraints
      expect(templates.mediatorSystem).toContain('Never quote')
      expect(templates.mediatorSystem).toContain('paraphrase closely')
      expect(templates.mediatorSystem).toContain('aggregate')
      expect(templates.mediatorSystem).toContain('several of you')
      expect(templates.mediatorSystem).toContain('PRIVACY:')
    })

    it('includes protection for individual sources', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      expect(templates.mediatorSystem).toContain('do not surface it')
      expect(templates.mediatorSystem).toContain('2+ independent signals')
      expect(templates.mediatorSystem).toContain('no individual could recognize their own words')
    })
  })

  describe('strategic silence emphasis', () => {
    it('emphasizes strategic silence in constraints', () => {
      const templates = createMediatorTemplates({ supportsModerator: true })

      expect(templates.mediatorSystem).toContain('Silence is a valid output')
      expect(templates.mediatorSystem).toContain('Most cycles should produce no intervention')
      expect(templates.mediatorSystem).toContain('Never repeat a theme')
      expect(templates.mediatorSystem).toContain('JUDGMENT:')
    })
  })
})
