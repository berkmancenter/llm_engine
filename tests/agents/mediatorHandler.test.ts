import { InterventionType, mediatorAnalysisSchema } from '../../src/agents/eventAssistant/mediatorHandler.js'

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

  describe('mediatorAnalysisSchema', () => {
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

      const result = mediatorAnalysisSchema.safeParse(validAnalysis)
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

      const result = mediatorAnalysisSchema.safeParse(validAnalysis)
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

      const result = mediatorAnalysisSchema.safeParse(validAnalysis)
      expect(result.success).toBe(true)
    })

    it('rejects invalid intervention type', () => {
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'INVALID_TYPE',
        reasoning: 'Test',
        confidenceScore: 50
      }

      const result = mediatorAnalysisSchema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    })

    it('rejects missing required fields', () => {
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'SIGNAL'
        // Missing reasoning and confidenceScore
      }

      const result = mediatorAnalysisSchema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    })

    it('rejects invalid confidence score range', () => {
      const invalidAnalysis = {
        shouldIntervene: true,
        interventionType: 'SIGNAL',
        reasoning: 'Test',
        confidenceScore: 150 // Over 100
      }

      const result = mediatorAnalysisSchema.safeParse(invalidAnalysis)
      expect(result.success).toBe(false)
    })

    it('accepts optional fields', () => {
      const minimalAnalysis = {
        shouldIntervene: false,
        interventionType: 'NONE',
        reasoning: 'Nothing happening',
        confidenceScore: 20
      }

      const result = mediatorAnalysisSchema.safeParse(minimalAnalysis)
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

        const result = mediatorAnalysisSchema.safeParse(analysis)
        expect(result.success).toBe(true)
      })
    })
  })

  describe('LLM templates', () => {
    it('imports mediator templates without error', async () => {
      const { mediatorLLMTemplates, mediatorLlmTemplateVars } = await import(
        '../../src/agents/eventAssistant/mediatorHandler.js'
      )

      expect(mediatorLLMTemplates).toBeDefined()
      expect(mediatorLLMTemplates.mediatorSystem).toBeDefined()
      expect(mediatorLLMTemplates.mediatorUser).toBeDefined()

      expect(mediatorLlmTemplateVars).toBeDefined()
      expect(mediatorLlmTemplateVars.mediatorSystem).toEqual([])
      expect(mediatorLlmTemplateVars.mediatorUser).toBeDefined()
    })

    it('system template includes core directives', async () => {
      const { mediatorLLMTemplates } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      // Check for key sections
      expect(mediatorLLMTemplates.mediatorSystem).toContain('## Voice')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('## Rules')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('PRIVACY:')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('JUDGMENT:')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('## Intervention Types')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('## Output Format')
    })

    it('system template describes all intervention types', async () => {
      const { mediatorLLMTemplates } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      expect(mediatorLLMTemplates.mediatorSystem).toContain('SIGNAL')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('SYNTHESIS')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('MINORITY_VOICE')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('CONFUSION')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('PROVOCATION')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('BRIDGE')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('STRUCTURE')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('PLAY')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('MODERATOR_ESCALATION')
    })

    it('user template includes all required context sections', async () => {
      const { mediatorLLMTemplates } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      expect(mediatorLLMTemplates.mediatorUser).toContain('## Event Topic:')
      expect(mediatorLLMTemplates.mediatorUser).toContain('## Recent Transcript')
      expect(mediatorLLMTemplates.mediatorUser).toContain('## Retrieved Relevant Context')
      expect(mediatorLLMTemplates.mediatorUser).toContain('## Private Messages')
      expect(mediatorLLMTemplates.mediatorUser).toContain('## Shared Chat History:')
      expect(mediatorLLMTemplates.mediatorUser).toContain('## Moderator Context:')
      expect(mediatorLLMTemplates.mediatorUser).toContain('## Your Recent Posts:')
    })

    it('template vars define expected user variables', async () => {
      const { mediatorLlmTemplateVars } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

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
    it('emphasizes privacy protection in system prompt', async () => {
      const { mediatorLLMTemplates } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      // Check for privacy-related constraints
      expect(mediatorLLMTemplates.mediatorSystem).toContain('Never quote')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('paraphrase closely')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('aggregate')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('several of you')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('PRIVACY:')
    })

    it('includes protection for individual sources', async () => {
      const { mediatorLLMTemplates } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      expect(mediatorLLMTemplates.mediatorSystem).toContain('do not surface it')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('2+ independent signals')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('no individual could recognize their own words')
    })
  })

  describe('strategic silence emphasis', () => {
    it('emphasizes strategic silence in constraints', async () => {
      const { mediatorLLMTemplates } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      expect(mediatorLLMTemplates.mediatorSystem).toContain('Silence is a valid output')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('Most cycles should produce no intervention')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('Never repeat a theme')
      expect(mediatorLLMTemplates.mediatorSystem).toContain('JUDGMENT:')
    })
  })
})
