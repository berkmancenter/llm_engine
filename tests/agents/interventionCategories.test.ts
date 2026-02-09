import {
  interventionCategories,
  defaultCategoriesConfig,
  getEnabledInterventions,
  shouldFetchPrivateMessages,
  getCategoryWeightGuidance,
  getCategoryForIntervention,
  InterventionCategoriesConfig,
  InterventionType
} from '../../src/agents/eventAssistant/interventionCategories.js'

describe('interventionCategories', () => {
  describe('category definitions', () => {
    it('defines collectiveConsciousness category', () => {
      const cc = interventionCategories.collectiveConsciousness
      expect(cc.name).toBe('collectiveConsciousness')
      expect(cc.requiresPrivateMessages).toBe(true)
      expect(cc.interventions).toContain(InterventionType.SIGNAL)
      expect(cc.interventions).toContain(InterventionType.SYNTHESIS)
      expect(cc.interventions).toContain(InterventionType.MINORITY_VOICE)
      expect(cc.interventions).toContain(InterventionType.CONFUSION)
      expect(cc.interventions).toContain(InterventionType.MODERATOR_ESCALATION)
    })

    it('defines engagement category', () => {
      const { engagement } = interventionCategories
      expect(engagement.name).toBe('engagement')
      expect(engagement.requiresPrivateMessages).toBe(false)
      expect(engagement.interventions).toContain(InterventionType.PROVOCATION)
      expect(engagement.interventions).toContain(InterventionType.PLAY)
    })

    it('defines facilitation category', () => {
      const { facilitation } = interventionCategories
      expect(facilitation.name).toBe('facilitation')
      expect(facilitation.requiresPrivateMessages).toBe(false)
      expect(facilitation.interventions).toContain(InterventionType.STRUCTURE)
      expect(facilitation.interventions).toContain(InterventionType.BRIDGE)
    })
  })

  describe('defaultCategoriesConfig', () => {
    it('enables all categories by default', () => {
      expect(defaultCategoriesConfig.collectiveConsciousness?.enabled).toBe(true)
      expect(defaultCategoriesConfig.engagement?.enabled).toBe(true)
      expect(defaultCategoriesConfig.facilitation?.enabled).toBe(true)
    })

    it('sets default weight of 1.0 for all categories', () => {
      expect(defaultCategoriesConfig.collectiveConsciousness?.weight).toBe(1.0)
      expect(defaultCategoriesConfig.engagement?.weight).toBe(1.0)
      expect(defaultCategoriesConfig.facilitation?.weight).toBe(1.0)
    })
  })

  describe('getEnabledInterventions', () => {
    it('returns all intervention types when all categories enabled', () => {
      const enabled = getEnabledInterventions(defaultCategoriesConfig, true)

      expect(enabled).toContain(InterventionType.SIGNAL)
      expect(enabled).toContain(InterventionType.SYNTHESIS)
      expect(enabled).toContain(InterventionType.MINORITY_VOICE)
      expect(enabled).toContain(InterventionType.CONFUSION)
      expect(enabled).toContain(InterventionType.PROVOCATION)
      expect(enabled).toContain(InterventionType.PLAY)
      expect(enabled).toContain(InterventionType.STRUCTURE)
      expect(enabled).toContain(InterventionType.BRIDGE)
      expect(enabled).toContain(InterventionType.MODERATOR_ESCALATION)
      expect(enabled).toContain(InterventionType.NONE)
    })

    it('excludes MODERATOR_ESCALATION when supportsModerator is false', () => {
      const enabled = getEnabledInterventions(defaultCategoriesConfig, false)

      expect(enabled).not.toContain(InterventionType.MODERATOR_ESCALATION)
      // Other collectiveConsciousness interventions should still be present
      expect(enabled).toContain(InterventionType.SIGNAL)
    })

    it('returns only engagement interventions when only engagement enabled', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: true, weight: 1.0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const enabled = getEnabledInterventions(config, false)

      expect(enabled).toContain(InterventionType.PROVOCATION)
      expect(enabled).toContain(InterventionType.PLAY)
      expect(enabled).toContain(InterventionType.NONE)
      expect(enabled).not.toContain(InterventionType.SIGNAL)
      expect(enabled).not.toContain(InterventionType.STRUCTURE)
    })

    it('returns only facilitation interventions when only facilitation enabled', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: false, weight: 0 },
        facilitation: { enabled: true, weight: 1.0 }
      }

      const enabled = getEnabledInterventions(config, false)

      expect(enabled).toContain(InterventionType.STRUCTURE)
      expect(enabled).toContain(InterventionType.BRIDGE)
      expect(enabled).toContain(InterventionType.NONE)
      expect(enabled).not.toContain(InterventionType.SIGNAL)
      expect(enabled).not.toContain(InterventionType.PROVOCATION)
    })

    it('returns only collectiveConsciousness interventions when only that category enabled', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: true, weight: 1.0 },
        engagement: { enabled: false, weight: 0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const enabled = getEnabledInterventions(config, true)

      expect(enabled).toContain(InterventionType.SIGNAL)
      expect(enabled).toContain(InterventionType.SYNTHESIS)
      expect(enabled).toContain(InterventionType.MINORITY_VOICE)
      expect(enabled).toContain(InterventionType.CONFUSION)
      expect(enabled).toContain(InterventionType.MODERATOR_ESCALATION)
      expect(enabled).toContain(InterventionType.NONE)
      expect(enabled).not.toContain(InterventionType.PROVOCATION)
      expect(enabled).not.toContain(InterventionType.STRUCTURE)
    })

    it('always includes NONE regardless of category config', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: false, weight: 0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const enabled = getEnabledInterventions(config, false)

      expect(enabled).toContain(InterventionType.NONE)
      expect(enabled).toHaveLength(1)
    })

    it('combines multiple enabled categories', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: true, weight: 1.0 }
      }

      const enabled = getEnabledInterventions(config, false)

      // Engagement
      expect(enabled).toContain(InterventionType.PROVOCATION)
      expect(enabled).toContain(InterventionType.PLAY)
      // Facilitation
      expect(enabled).toContain(InterventionType.STRUCTURE)
      expect(enabled).toContain(InterventionType.BRIDGE)
      // Not collectiveConsciousness
      expect(enabled).not.toContain(InterventionType.SIGNAL)
    })
  })

  describe('shouldFetchPrivateMessages', () => {
    it('returns true when collectiveConsciousness is enabled', () => {
      expect(shouldFetchPrivateMessages(defaultCategoriesConfig)).toBe(true)
    })

    it('returns false when only engagement is enabled', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: true, weight: 1.0 },
        facilitation: { enabled: false, weight: 0 }
      }

      expect(shouldFetchPrivateMessages(config)).toBe(false)
    })

    it('returns false when only facilitation is enabled', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: false, weight: 0 },
        facilitation: { enabled: true, weight: 1.0 }
      }

      expect(shouldFetchPrivateMessages(config)).toBe(false)
    })

    it('returns false when engagement and facilitation are enabled but not collectiveConsciousness', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: true, weight: 1.0 }
      }

      expect(shouldFetchPrivateMessages(config)).toBe(false)
    })

    it('returns true when collectiveConsciousness is enabled alongside others', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: true, weight: 0.5 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: false, weight: 0 }
      }

      expect(shouldFetchPrivateMessages(config)).toBe(true)
    })
  })

  describe('getCategoryWeightGuidance', () => {
    it('returns guidance for equal weights', () => {
      const guidance = getCategoryWeightGuidance(defaultCategoriesConfig)

      expect(guidance).toContain('## Intervention Priorities')
      expect(guidance).toContain('equal priority')
      expect(guidance).toContain('collectiveConsciousness')
      expect(guidance).toContain('engagement')
      expect(guidance).toContain('facilitation')
    })

    it('returns guidance with priority levels for different weights', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: true, weight: 0.5 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: true, weight: 1.0 }
      }

      const guidance = getCategoryWeightGuidance(config)

      expect(guidance).toContain('## Intervention Priorities')
      expect(guidance).toContain('engagement')
      expect(guidance).toContain('HIGH')
      expect(guidance).toContain('weight: 2')
      expect(guidance).toContain('collectiveConsciousness')
      expect(guidance).toContain('LOW')
      expect(guidance).toContain('weight: 0.5')
    })

    it('returns "should not intervene" message when no categories enabled', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: false, weight: 0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const guidance = getCategoryWeightGuidance(config)

      expect(guidance).toContain('should not intervene')
    })

    it('orders categories by weight descending', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: true, weight: 0.5 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: true, weight: 1.0 }
      }

      const guidance = getCategoryWeightGuidance(config)

      // engagement (2.0) should appear before facilitation (1.0) which should appear before collectiveConsciousness (0.5)
      const engagementPos = guidance.indexOf('engagement')
      const facilitationPos = guidance.indexOf('facilitation')
      const ccPos = guidance.indexOf('collectiveConsciousness')

      expect(engagementPos).toBeLessThan(facilitationPos)
      expect(facilitationPos).toBeLessThan(ccPos)
    })

    it('only includes enabled categories in guidance', () => {
      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const guidance = getCategoryWeightGuidance(config)

      expect(guidance).toContain('engagement')
      expect(guidance).not.toContain('collectiveConsciousness')
      expect(guidance).not.toContain('facilitation')
    })
  })

  describe('getCategoryForIntervention', () => {
    it('returns collectiveConsciousness for SIGNAL', () => {
      expect(getCategoryForIntervention(InterventionType.SIGNAL)).toBe('collectiveConsciousness')
    })

    it('returns collectiveConsciousness for SYNTHESIS', () => {
      expect(getCategoryForIntervention(InterventionType.SYNTHESIS)).toBe('collectiveConsciousness')
    })

    it('returns collectiveConsciousness for MINORITY_VOICE', () => {
      expect(getCategoryForIntervention(InterventionType.MINORITY_VOICE)).toBe('collectiveConsciousness')
    })

    it('returns collectiveConsciousness for CONFUSION', () => {
      expect(getCategoryForIntervention(InterventionType.CONFUSION)).toBe('collectiveConsciousness')
    })

    it('returns collectiveConsciousness for MODERATOR_ESCALATION', () => {
      expect(getCategoryForIntervention(InterventionType.MODERATOR_ESCALATION)).toBe('collectiveConsciousness')
    })

    it('returns engagement for PROVOCATION', () => {
      expect(getCategoryForIntervention(InterventionType.PROVOCATION)).toBe('engagement')
    })

    it('returns engagement for PLAY', () => {
      expect(getCategoryForIntervention(InterventionType.PLAY)).toBe('engagement')
    })

    it('returns facilitation for STRUCTURE', () => {
      expect(getCategoryForIntervention(InterventionType.STRUCTURE)).toBe('facilitation')
    })

    it('returns facilitation for BRIDGE', () => {
      expect(getCategoryForIntervention(InterventionType.BRIDGE)).toBe('facilitation')
    })

    it('returns null for NONE', () => {
      expect(getCategoryForIntervention(InterventionType.NONE)).toBe(null)
    })
  })

  describe('integration: category config affects system prompt', () => {
    it('engagement-only config produces prompt without collectiveConsciousness interventions', async () => {
      const { getMediatorSystemPrompt } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: false, weight: 0 },
        engagement: { enabled: true, weight: 2.0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const enabledInterventions = getEnabledInterventions(config, false)
      const prompt = getMediatorSystemPrompt(enabledInterventions, config, false)

      // Should include engagement interventions
      expect(prompt).toContain('PROVOCATION')
      expect(prompt).toContain('PLAY')

      // Should NOT include collectiveConsciousness interventions in the intervention types section
      // (they may appear in category guidance but not as selectable options)
      expect(prompt).not.toMatch(/### SIGNAL/)
      expect(prompt).not.toMatch(/### SYNTHESIS/)
    })

    it('collectiveConsciousness-only config produces prompt without engagement interventions', async () => {
      const { getMediatorSystemPrompt } = await import('../../src/agents/eventAssistant/mediatorHandler.js')

      const config: InterventionCategoriesConfig = {
        collectiveConsciousness: { enabled: true, weight: 1.0 },
        engagement: { enabled: false, weight: 0 },
        facilitation: { enabled: false, weight: 0 }
      }

      const enabledInterventions = getEnabledInterventions(config, false)
      const prompt = getMediatorSystemPrompt(enabledInterventions, config, false)

      // Should include collectiveConsciousness interventions
      expect(prompt).toContain('SIGNAL')
      expect(prompt).toContain('SYNTHESIS')

      // Should NOT include engagement interventions as sections
      expect(prompt).not.toMatch(/### PROVOCATION/)
      expect(prompt).not.toMatch(/### PLAY/)
    })
  })
})
