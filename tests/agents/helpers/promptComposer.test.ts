import {
  getEligibleGoals,
  getConfidenceThreshold,
  getMinContributionMs,
  getEffectiveMinConfidence,
  filterAndSortGoalsByPriority,
  buildConversationContextSection,
  buildBehaviorPolicySection,
  buildGoalInstructions,
  composeSystemPrompt
} from '../../../src/agents/helpers/promptComposer.js'
import type { BehaviorPolicy, ConversationContext, ConversationGoal } from '../../../src/types/index.types.js'

const FIXTURE_GROUP_GOAL: ConversationGoal = {
  id: 'provoke_participation',
  label: 'Provoke participation',
  description: 'Generates energy and draws out participation when quiet.',
  channel: 'groupChat',
  triggers: {
    conditions: [
      { scope: 'participant', condition: 'participation is currently low — few or no messages in the last few minutes' }
    ],
    minConfidence: 65
  },
  guardrails: ["don't introduce provocation into an already heated exchange"],
  outputContract: { format: 'text' },
  examples: ['Throwing this out there: what would change your mind on this?']
}

const FIXTURE_DM_GOAL: ConversationGoal = {
  id: 'private_reassure',
  label: 'Reassure privately',
  description: 'Sends a warm private message to a participant who seems to be doubting themselves.',
  channel: 'dm',
  triggers: {
    conditions: [{ scope: 'participant', condition: 'participant shows signs of self-doubt' }],
    minConfidence: 60
  },
  guardrails: ['keep it warm and brief'],
  outputContract: { format: 'text' },
  examples: []
}

const FIXTURE_BRIDGE_GOAL: ConversationGoal = {
  id: 'bridge_topics',
  label: 'Bridge topics',
  description: 'Connects ideas from different parts of the conversation.',
  channel: 'groupChat',
  triggers: {
    conditions: [{ scope: 'participant', condition: 'a topic shift has occurred' }],
    minConfidence: 60
  },
  guardrails: ["don't redirect a conversation that is still productive"],
  outputContract: { format: 'text' },
  examples: []
}

describe('getEligibleGoals', () => {
  test('returns empty array when goals undefined', () => {
    expect(getEligibleGoals(undefined)).toEqual([])
  })

  test('returns empty array when goals is empty', () => {
    expect(getEligibleGoals([])).toEqual([])
  })

  test('loads valid goal ids', () => {
    const result = getEligibleGoals(['provoke_participation', 'bridge_topics'])
    expect(result).toHaveLength(2)
    expect(result.map((g) => g.id)).toEqual(['provoke_participation', 'bridge_topics'])
  })

  test('returns empty array for unknown goal ids (swallows error)', () => {
    expect(getEligibleGoals(['does_not_exist'])).toEqual([])
  })

  test('filters out poll_reveal when pollPolicy.allowed is false', () => {
    const result = getEligibleGoals(['provoke_participation', 'poll_reveal'], { pollPolicy: { allowed: false } })
    expect(result.map((g) => g.id)).not.toContain('poll_reveal')
    expect(result.map((g) => g.id)).toContain('provoke_participation')
  })

  test('keeps poll_reveal when pollPolicy.allowed is true', () => {
    const result = getEligibleGoals(['provoke_participation', 'poll_reveal'], { pollPolicy: { allowed: true } })
    expect(result.map((g) => g.id)).toContain('poll_reveal')
  })

  test('keeps poll_reveal when pollPolicy is not set', () => {
    const result = getEligibleGoals(['poll_reveal'])
    expect(result.map((g) => g.id)).toContain('poll_reveal')
  })
})

describe('getConfidenceThreshold', () => {
  test('returns 75 for high social sensitivity', () => {
    expect(getConfidenceThreshold({ socialSensitivity: 'high' })).toBe(75)
  })

  test('returns 60 for medium social sensitivity', () => {
    expect(getConfidenceThreshold({ socialSensitivity: 'medium' })).toBe(60)
  })

  test('returns 60 for low social sensitivity', () => {
    expect(getConfidenceThreshold({ socialSensitivity: 'low' })).toBe(60)
  })

  test('returns 60 when proactivePolicy is undefined', () => {
    expect(getConfidenceThreshold(undefined)).toBe(60)
  })
})

describe('getMinContributionMs', () => {
  test('uses proactivePolicy.minContributionMinutes when set', () => {
    expect(getMinContributionMs({ minContributionMinutes: 5 })).toBe(5 * 60 * 1000)
  })

  test('falls back to agentConfig.minInterval', () => {
    expect(getMinContributionMs(undefined, { minInterval: 10 })).toBe(10 * 60 * 1000)
  })

  test('defaults to 2 minutes when both are absent', () => {
    expect(getMinContributionMs(undefined, undefined)).toBe(2 * 60 * 1000)
  })

  test('proactivePolicy.minContributionMinutes takes precedence over agentConfig.minInterval', () => {
    expect(getMinContributionMs({ minContributionMinutes: 3 }, { minInterval: 10 })).toBe(3 * 60 * 1000)
  })
})

describe('buildConversationContextSection', () => {
  test('returns empty string when conversationContext is undefined', () => {
    expect(buildConversationContextSection(undefined)).toBe('')
  })

  test('returns empty string when conversationType is not set', () => {
    expect(buildConversationContextSection({ purpose: 'teamBuilding' })).toBe('')
  })

  test('renders conversationType', () => {
    const ctx: ConversationContext = { conversationType: 'webinar' }
    const result = buildConversationContextSection(ctx)
    expect(result).toContain('## Event Context')
    expect(result).toContain('This is a webinar')
  })

  test('renders purpose when present', () => {
    const ctx: ConversationContext = { conversationType: 'workshop', purpose: 'Team building and alignment' }
    expect(buildConversationContextSection(ctx)).toContain('Purpose: Team building and alignment.')
  })

  test('renders audience expertise and type', () => {
    const ctx: ConversationContext = {
      conversationType: 'conference',
      audience: { expertiseLevel: 'expert', type: ['engineers', 'designers'] }
    }
    const result = buildConversationContextSection(ctx)
    expect(result).toContain('expert expertise level')
    expect(result).toContain('engineers, designers')
  })

  test('renders assumedBackgroundKnowledge', () => {
    const ctx: ConversationContext = {
      conversationType: 'lecture',
      audience: { assumedBackgroundKnowledge: 'low' }
    }
    expect(buildConversationContextSection(ctx)).toContain('low background knowledge assumed')
  })

  test('renders audience description', () => {
    const ctx: ConversationContext = {
      conversationType: 'panel',
      audience: { description: 'A mixed group of early-career practitioners.' }
    }
    expect(buildConversationContextSection(ctx)).toContain('A mixed group of early-career practitioners.')
  })

  test('omits audience line when no audience fields are set', () => {
    const ctx: ConversationContext = { conversationType: 'roundtable', audience: {} }
    const result = buildConversationContextSection(ctx)
    expect(result).not.toContain('Audience:')
  })

  test('renders contentSensitivity level when elevated', () => {
    const ctx: ConversationContext = {
      conversationType: 'panel',
      contentSensitivity: { level: 'elevated', domains: ['mental health'] }
    }
    const result = buildConversationContextSection(ctx)
    expect(result).toContain('Content sensitivity:')
    expect(result).toContain('elevated')
    expect(result).toContain('mental health')
  })

  test('omits level and domains lines when level is standard and no domains set', () => {
    const ctx: ConversationContext = {
      conversationType: 'panel',
      contentSensitivity: { level: 'standard' }
    }
    const result = buildConversationContextSection(ctx)
    expect(result).not.toContain('Level:')
    expect(result).not.toContain('Sensitive domains:')
  })
})

// Minimal valid globalPolicy satisfying required fields — spread into tests that only exercise one field.
const BASE_GLOBAL_POLICY = {
  tone: 'clearNeutral' as const,
  verbosity: 'brief' as const,
  formality: 'semiFormal' as const,
  jargonLevel: 'medium' as const,
  safetyPosture: 'standard' as const
}

describe('buildBehaviorPolicySection', () => {
  test('returns empty string when policy is undefined', () => {
    expect(buildBehaviorPolicySection(undefined, 'groupChat')).toBe('')
  })

  test('returns empty string when policy produces no guidelines', () => {
    expect(buildBehaviorPolicySection({}, 'groupChat')).toBe('')
  })

  describe('globalPolicy tone', () => {
    const tones = [
      ['clearNeutral', 'clear and neutral'],
      ['warmSupportive', 'warm and supportive'],
      ['playful', 'playful'],
      ['professional', 'professional']
    ] as const

    test.each(tones)('renders %s tone', (tone, expected) => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, tone } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain(expected)
    })
  })

  describe('globalPolicy formality', () => {
    test('renders casual', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, formality: 'casual' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Casual, conversational register')
    })

    test('renders semiFormal', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, formality: 'semiFormal' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Semi-formal register')
    })

    test('renders formal', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, formality: 'formal' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Formal register')
    })
  })

  describe('globalPolicy verbosity', () => {
    test.each(['brief', 'medium', 'detailed'] as const)('renders %s verbosity', (verbosity) => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, verbosity } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('## Behavioral Guidelines')
    })
  })

  describe('globalPolicy jargonLevel', () => {
    test('low jargon renders accessible language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, jargonLevel: 'low' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('accessible language')
    })

    test('lowToMedium jargon renders accessible language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, jargonLevel: 'lowToMedium' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('accessible language')
    })

    test('high jargon renders technical language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, jargonLevel: 'high' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Technical language')
    })

    test('medium jargon renders balanced language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, jargonLevel: 'medium' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Balanced language')
    })
  })

  describe('globalPolicy freeform fields', () => {
    test('renders citationBehavior', () => {
      const policy: BehaviorPolicy = {
        globalPolicy: { ...BASE_GLOBAL_POLICY, citationBehavior: 'Always cite sources inline' }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Always cite sources inline')
    })

    test('renders uncertaintyBehavior', () => {
      const policy: BehaviorPolicy = {
        globalPolicy: { ...BASE_GLOBAL_POLICY, uncertaintyBehavior: 'Flag uncertainty clearly' }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Flag uncertainty clearly')
    })

    test('renders guardrails list', () => {
      const policy: BehaviorPolicy = {
        globalPolicy: { ...BASE_GLOBAL_POLICY, guardrails: ['Never speculate about participants', 'Do not editorialize'] }
      }
      const result = buildBehaviorPolicySection(policy, 'groupChat')
      expect(result).toContain('Guardrails:')
      expect(result).toContain('- Never speculate about participants')
      expect(result).toContain('- Do not editorialize')
    })
  })

  const BASE_QA_BEHAVIOR = { answerScope: 'broaderSubjectArea' as const, responseLength: 'medium' as const }
  const BASE_PROACTIVE_POLICY = { initiativeLevel: 'lightlyProactive' as const, socialSensitivity: 'medium' as const }

  describe('dm qaBehavior', () => {
    test('renders clarifyWhenAmbiguous', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, clarifyWhenAmbiguous: true } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('clarifying question')
    })

    test('renders addContextWhenUseful', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, addContextWhenUseful: true } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('bridging context')
    })

    test('renders allowFollowUpDialogue', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, allowFollowUpDialogue: true } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('invite continued dialogue')
    })

    test('renders companyContextOnly answerScope', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, answerScope: 'companyContextOnly' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('company or internal context only')
    })

    test('renders helpUserUnderstandTheLecture answerScope', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, answerScope: 'helpUserUnderstandTheLecture' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('understand the content being presented')
    })

    test('renders broaderSubjectArea answerScope', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, answerScope: 'broaderSubjectArea' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('broader subject area')
    })

    test('does not render dm qaBehavior when channelType is groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, clarifyWhenAmbiguous: true } } }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).not.toContain('clarifying question')
    })

    describe('responseLength', () => {
      test.each([
        ['short', 'one to two sentences'],
        ['medium', 'Medium length answers'],
        ['long', 'completeness is more important']
      ] as const)('renders %s responseLength', (responseLength, expected) => {
        const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, responseLength } } } }
        expect(buildBehaviorPolicySection(policy, 'dm')).toContain(expected)
      })

      test('responseLength is not emitted for groupChat', () => {
        const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { ...BASE_QA_BEHAVIOR, responseLength: 'short' } } } }
        expect(buildBehaviorPolicySection(policy, 'groupChat')).not.toContain('one to two sentences')
      })
    })
  })

  describe('proactivePolicy initiativeLevel', () => {
    test('renders lightlyProactive for groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { ...BASE_PROACTIVE_POLICY, initiativeLevel: 'lightlyProactive' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Intervene sparingly')
    })

    test('renders moderatelyProactive for groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { ...BASE_PROACTIVE_POLICY, initiativeLevel: 'moderatelyProactive' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Intervene regularly')
    })

    test('renders highlyProactive for dm', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { proactivePolicy: { ...BASE_PROACTIVE_POLICY, initiativeLevel: 'highlyProactive' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('Participate actively')
    })

    test('passive initiativeLevel renders no initiative line', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { ...BASE_PROACTIVE_POLICY, initiativeLevel: 'passive' } } }
      }
      const result = buildBehaviorPolicySection(policy, 'groupChat')
      expect(result).not.toContain('Intervene')
      expect(result).not.toContain('Participate')
    })
  })

  describe('groupChat guardrails', () => {
    test('renders groupChat guardrails when channelType is groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { guardrails: ['Never quote private messages', 'Abstract themes'] } }
      }
      const result = buildBehaviorPolicySection(policy, 'groupChat')
      expect(result).toContain('Guardrails:')
      expect(result).toContain('- Never quote private messages')
      expect(result).toContain('- Abstract themes')
    })

    test('does not render groupChat guardrails when channelType is dm', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { guardrails: ['Never quote private messages'] } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).not.toContain('Never quote private messages')
    })
  })

  describe('dm guardrails', () => {
    test('renders dm guardrails when channelType is dm', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { guardrails: ['Keep responses brief', 'Do not diagnose emotional states'] } }
      }
      const result = buildBehaviorPolicySection(policy, 'dm')
      expect(result).toContain('Guardrails:')
      expect(result).toContain('- Keep responses brief')
      expect(result).toContain('- Do not diagnose emotional states')
    })

    test('does not render dm guardrails when channelType is groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { guardrails: ['Keep responses brief'] } }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).not.toContain('Keep responses brief')
    })
  })

  test('merges global and channel guardrails under a single Guardrails header', () => {
    const policy: BehaviorPolicy = {
      globalPolicy: { ...BASE_GLOBAL_POLICY, guardrails: ['Never speculate about participants'] },
      channels: { groupChat: { guardrails: ['Never quote private messages'] } }
    }
    const result = buildBehaviorPolicySection(policy, 'groupChat')
    const guardrailsCount = (result.match(/^Guardrails:$/gm) ?? []).length
    expect(guardrailsCount).toBe(1)
    expect(result).toContain('- Never speculate about participants')
    expect(result).toContain('- Never quote private messages')
  })
})

describe('buildGoalInstructions', () => {
  test('returns empty string when goals list is empty', () => {
    expect(buildGoalInstructions([], 'groupChat')).toBe('')
  })

  test('returns empty string when no goals match the channel type', () => {
    expect(buildGoalInstructions([FIXTURE_DM_GOAL], 'groupChat')).toBe('')
  })

  test('renders groupChat goal with label and description', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat')
    expect(result).toContain('## Active Behavioral Patterns')
    expect(result).toContain('### Provoke participation')
    expect(result).toContain('Generates energy')
  })

  test('renders trigger conditions', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat')
    expect(result).toContain('Trigger when:')
    expect(result).toContain('participation is currently low')
  })

  test('renders guardrails', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat')
    expect(result).toContain('Guardrails:')
    expect(result).toContain("don't introduce provocation")
  })

  test('renders examples', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat')
    expect(result).toContain('Examples:')
    expect(result).toContain('Throwing this out there')
  })

  test('renders dm goal when channelType is dm', () => {
    const result = buildGoalInstructions([FIXTURE_DM_GOAL], 'dm')
    expect(result).toContain('### Reassure privately')
  })

  test('filters out dm goals when channelType is groupChat', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL, FIXTURE_DM_GOAL], 'groupChat')
    expect(result).toContain('Provoke participation')
    expect(result).not.toContain('Reassure privately')
  })

  test('renders multiple goals', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL], 'groupChat')
    expect(result).toContain('### Provoke participation')
    expect(result).toContain('### Bridge topics')
  })
})

const FIXTURE_SYNTHESIZE_GOAL: ConversationGoal = {
  id: 'synthesize_discussion',
  label: 'Synthesize discussion',
  description: 'Draws together threads from across the conversation.',
  channel: 'groupChat',
  triggers: { conditions: [{ scope: 'participant', condition: 'multiple threads are active' }], minConfidence: 60 },
  guardrails: [],
  outputContract: { format: 'text' },
  examples: []
}

describe('getEffectiveMinConfidence', () => {
  test('returns goal minConfidence unchanged when goalPriorities is absent', () => {
    expect(getEffectiveMinConfidence(FIXTURE_GROUP_GOAL, undefined)).toBe(65)
  })

  test('returns goal minConfidence unchanged when goal not listed in priorities', () => {
    expect(getEffectiveMinConfidence(FIXTURE_GROUP_GOAL, {})).toBe(65)
  })

  test('lowers threshold for high-priority goal (priority 100 → −15 modifier)', () => {
    expect(getEffectiveMinConfidence(FIXTURE_GROUP_GOAL, { provoke_participation: 100 })).toBe(50)
  })

  test('raises threshold for low-priority goal (priority 0 → +15 modifier)', () => {
    expect(getEffectiveMinConfidence(FIXTURE_GROUP_GOAL, { provoke_participation: 0 })).toBe(80)
  })

  test('no modifier at default priority 50', () => {
    expect(getEffectiveMinConfidence(FIXTURE_GROUP_GOAL, { provoke_participation: 50 })).toBe(65)
  })

  test('clamps result at 0 when modifier would go below 0', () => {
    const veryLowBase: ConversationGoal = { ...FIXTURE_GROUP_GOAL, triggers: { ...FIXTURE_GROUP_GOAL.triggers, minConfidence: 5 } }
    expect(getEffectiveMinConfidence(veryLowBase, { provoke_participation: 100 })).toBe(0)
  })

  test('clamps result at 100 when modifier would exceed 100', () => {
    const veryHighBase: ConversationGoal = { ...FIXTURE_GROUP_GOAL, triggers: { ...FIXTURE_GROUP_GOAL.triggers, minConfidence: 95 } }
    expect(getEffectiveMinConfidence(veryHighBase, { provoke_participation: 0 })).toBe(100)
  })
})

describe('filterAndSortGoalsByPriority', () => {
  test('returns goals unchanged when goalPriorities is absent', () => {
    const goals = [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL]
    expect(filterAndSortGoalsByPriority(goals, undefined)).toStrictEqual(goals)
  })

  test('removes goals with priority 0', () => {
    const result = filterAndSortGoalsByPriority([FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL], {
      provoke_participation: 0
    })
    expect(result.map((g) => g.id)).toEqual(['bridge_topics'])
  })

  test('sorts goals by priority descending', () => {
    const result = filterAndSortGoalsByPriority([FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL, FIXTURE_SYNTHESIZE_GOAL], {
      provoke_participation: 20,
      bridge_topics: 80,
      synthesize_discussion: 50
    })
    expect(result.map((g) => g.id)).toEqual(['bridge_topics', 'synthesize_discussion', 'provoke_participation'])
  })

  test('unlisted goals default to priority 50 and sort accordingly', () => {
    const result = filterAndSortGoalsByPriority([FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL], {
      bridge_topics: 70
    })
    expect(result[0].id).toBe('bridge_topics')
    expect(result[1].id).toBe('provoke_participation')
  })

  test('all-default priorities preserves relative order', () => {
    const goals = [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL]
    const result = filterAndSortGoalsByPriority(goals, {})
    expect(result.map((g) => g.id)).toEqual(['provoke_participation', 'bridge_topics'])
  })
})

describe('buildGoalInstructions with goalPriorities', () => {
  test('renders ranked preference list when priorities differ from default', () => {
    const result = buildGoalInstructions(
      [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL],
      'groupChat',
      { provoke_participation: 80, bridge_topics: 30 }
    )
    expect(result).toContain('When multiple patterns apply simultaneously')
    expect(result).toContain('1. Provoke participation')
    expect(result).toContain('2. Bridge topics')
  })

  test('does not render ranked list when only one channel goal', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat', { provoke_participation: 80 })
    expect(result).not.toContain('When multiple patterns apply simultaneously')
  })

  test('does not render ranked list when all priorities are default (50)', () => {
    const result = buildGoalInstructions(
      [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL],
      'groupChat',
      { provoke_participation: 50, bridge_topics: 50 }
    )
    expect(result).not.toContain('When multiple patterns apply simultaneously')
  })

  test('does not render ranked list when goalPriorities is absent', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL], 'groupChat')
    expect(result).not.toContain('When multiple patterns apply simultaneously')
  })

  test('adds preferred tier label for high-priority goal', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat', { provoke_participation: 80 })
    expect(result).toContain('Preferred pattern')
  })

  test('adds use-sparingly tier label for low-priority goal', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat', { provoke_participation: 20 })
    expect(result).toContain('Use sparingly')
  })

  test('adds no tier label for normal priority goal', () => {
    const result = buildGoalInstructions([FIXTURE_GROUP_GOAL], 'groupChat', { provoke_participation: 50 })
    expect(result).not.toContain('Preferred pattern')
    expect(result).not.toContain('Use sparingly')
  })

  test('ranked list reflects priority order, not input order', () => {
    const result = buildGoalInstructions(
      [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL],
      'groupChat',
      { provoke_participation: 30, bridge_topics: 70 }
    )
    const bridgePos = result.indexOf('Bridge topics')
    const provokePos = result.indexOf('Provoke participation')
    expect(bridgePos).toBeLessThan(provokePos)
  })

  test('goals with priority 0 filtered out before reaching buildGoalInstructions via composeSystemPrompt', () => {
    const result = composeSystemPrompt('Base.', {
      goals: [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL],
      channelType: 'groupChat',
      goalPriorities: { provoke_participation: 0, bridge_topics: 70 }
    })
    expect(result).not.toContain('Provoke participation')
    expect(result).toContain('Bridge topics')
  })
})

describe('composeSystemPrompt with goalPriorities', () => {
  test('passes goalPriorities through to goal section', () => {
    const result = composeSystemPrompt('Base.', {
      goals: [FIXTURE_GROUP_GOAL, FIXTURE_BRIDGE_GOAL],
      channelType: 'groupChat',
      goalPriorities: { provoke_participation: 80, bridge_topics: 30 }
    })
    expect(result).toContain('When multiple patterns apply simultaneously')
    expect(result).toContain('Preferred pattern')
  })

  test('goal section is unchanged when goalPriorities is absent', () => {
    const withPriorities = composeSystemPrompt('Base.', {
      goals: [FIXTURE_GROUP_GOAL],
      channelType: 'groupChat'
    })
    expect(withPriorities).not.toContain('When multiple patterns apply simultaneously')
    expect(withPriorities).not.toContain('Preferred pattern')
  })
})

describe('composeSystemPrompt', () => {
  test('returns base prompt alone when no options provided', () => {
    expect(composeSystemPrompt('You are an assistant.')).toBe('You are an assistant.')
  })

  test('appends context section when conversationContext provided', () => {
    const ctx: ConversationContext = { conversationType: 'summit' }
    const result = composeSystemPrompt('Base.', { conversationContext: ctx })
    expect(result).toContain('## Event Context')
  })

  test('appends policy section when behaviorPolicy provided', () => {
    const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY, tone: 'professional' } }
    const result = composeSystemPrompt('Base.', { behaviorPolicy: policy })
    expect(result).toContain('## Behavioral Guidelines')
  })

  test('appends goal instructions when goals and channelType provided', () => {
    const result = composeSystemPrompt('Base.', { goals: [FIXTURE_GROUP_GOAL], channelType: 'groupChat' })
    expect(result).toContain('## Active Behavioral Patterns')
  })

  test('does not append goal instructions when channelType is missing', () => {
    const result = composeSystemPrompt('Base.', { goals: [FIXTURE_GROUP_GOAL] })
    expect(result).not.toContain('## Active Behavioral Patterns')
  })

  test('appends personality section when personalityName provided', () => {
    const result = composeSystemPrompt('Base.', { personalityName: 'sarcastic-expert' })
    expect(result).toContain('RUTHLESS BREVITY')
  })

  test('unknown personalityName does not append anything', () => {
    const result = composeSystemPrompt('Base.', { personalityName: 'nonexistent-personality' })
    expect(result).toBe('Base.')
  })

  test('sections are separated by double newlines', () => {
    const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY } }
    const result = composeSystemPrompt('Base.', { behaviorPolicy: policy })
    expect(result).toContain('Base.\n\n')
  })

  test('composes all parts in canonical order: base → context → policy → goals → personality', () => {
    const ctx: ConversationContext = { conversationType: 'summit' }
    const policy: BehaviorPolicy = { globalPolicy: { ...BASE_GLOBAL_POLICY } }
    const result = composeSystemPrompt('Base.', {
      conversationContext: ctx,
      behaviorPolicy: policy,
      goals: [FIXTURE_GROUP_GOAL],
      channelType: 'groupChat',
      personalityName: 'sarcastic-expert'
    })
    const ctxIdx = result.indexOf('## Event Context')
    const policyIdx = result.indexOf('## Behavioral Guidelines')
    const goalIdx = result.indexOf('## Active Behavioral Patterns')
    const personalityIdx = result.indexOf('RUTHLESS BREVITY')
    expect(result.indexOf('Base.')).toBeLessThan(ctxIdx)
    expect(ctxIdx).toBeLessThan(policyIdx)
    expect(policyIdx).toBeLessThan(goalIdx)
    expect(goalIdx).toBeLessThan(personalityIdx)
  })
})
