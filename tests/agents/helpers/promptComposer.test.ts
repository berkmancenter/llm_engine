import {
  getEligibleGoals,
  getConfidenceThreshold,
  getMinContributionMs,
  buildConversationContextSection,
  buildBehaviorPolicySection,
  buildGoalInstructions,
  composeSystemPrompt
} from '../../../src/agents/helpers/promptComposer.js'
import { loadGoals } from '../../../src/goals/loader.js'
import type { BehaviorPolicy, ConversationContext } from '../../../src/types/index.types.js'

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
})

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
      const policy: BehaviorPolicy = { globalPolicy: { tone } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain(expected)
    })
  })

  describe('globalPolicy formality', () => {
    test('renders casual', () => {
      const policy: BehaviorPolicy = { globalPolicy: { formality: 'casual' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Casual, conversational register')
    })

    test('renders semiFormal', () => {
      const policy: BehaviorPolicy = { globalPolicy: { formality: 'semiFormal' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Semi-formal register')
    })

    test('renders formal', () => {
      const policy: BehaviorPolicy = { globalPolicy: { formality: 'formal' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Formal register')
    })
  })

  describe('globalPolicy verbosity', () => {
    test.each(['brief', 'medium', 'detailed'] as const)('renders %s verbosity', (verbosity) => {
      const policy: BehaviorPolicy = { globalPolicy: { verbosity } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('## Behavioral Guidelines')
    })
  })

  describe('globalPolicy jargonLevel', () => {
    test('low jargon renders accessible language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { jargonLevel: 'low' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('accessible language')
    })

    test('lowToMedium jargon renders accessible language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { jargonLevel: 'lowToMedium' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('accessible language')
    })

    test('high jargon renders technical language line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { jargonLevel: 'high' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Technical language')
    })

    test('medium jargon renders no jargon line', () => {
      const policy: BehaviorPolicy = { globalPolicy: { jargonLevel: 'medium' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).not.toContain('language')
    })
  })

  describe('globalPolicy freeform fields', () => {
    test('renders citationBehavior', () => {
      const policy: BehaviorPolicy = { globalPolicy: { citationBehavior: 'Always cite sources inline' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Always cite sources inline')
    })

    test('renders uncertaintyBehavior', () => {
      const policy: BehaviorPolicy = { globalPolicy: { uncertaintyBehavior: 'Flag uncertainty clearly' } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Flag uncertainty clearly')
    })

    test('renders guardrails list', () => {
      const policy: BehaviorPolicy = {
        globalPolicy: { guardrails: ['Never speculate about participants', 'Do not editorialize'] }
      }
      const result = buildBehaviorPolicySection(policy, 'groupChat')
      expect(result).toContain('Guardrails:')
      expect(result).toContain('- Never speculate about participants')
      expect(result).toContain('- Do not editorialize')
    })
  })

  describe('dm qaBehavior', () => {
    test('renders clarifyWhenAmbiguous', () => {
      const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { clarifyWhenAmbiguous: true } } } }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('clarifying question')
    })

    test('renders addContextWhenUseful', () => {
      const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { addContextWhenUseful: true } } } }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('bridging context')
    })

    test('renders allowFollowUpDialogue', () => {
      const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { allowFollowUpDialogue: true } } } }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('invite continued dialogue')
    })

    test('renders companyContextOnly answerScope', () => {
      const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { answerScope: 'companyContextOnly' } } } }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('company or internal context only')
    })

    test('renders helpUserUnderstandTheLecture answerScope', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { qaBehavior: { answerScope: 'helpUserUnderstandTheLecture' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('understand the content being presented')
    })

    test('renders broaderSubjectArea answerScope', () => {
      const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { answerScope: 'broaderSubjectArea' } } } }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('broader subject area')
    })

    test('does not render dm qaBehavior when channelType is groupChat', () => {
      const policy: BehaviorPolicy = { channels: { dm: { qaBehavior: { clarifyWhenAmbiguous: true } } } }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).not.toContain('clarifying question')
    })
  })

  describe('proactivePolicy initiativeLevel', () => {
    test('renders lightlyProactive for groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { initiativeLevel: 'lightlyProactive' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Intervene sparingly')
    })

    test('renders moderatelyProactive for groupChat', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { initiativeLevel: 'moderatelyProactive' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'groupChat')).toContain('Intervene regularly')
    })

    test('renders highlyProactive for dm', () => {
      const policy: BehaviorPolicy = {
        channels: { dm: { proactivePolicy: { initiativeLevel: 'highlyProactive' } } }
      }
      expect(buildBehaviorPolicySection(policy, 'dm')).toContain('Participate actively')
    })

    test('passive initiativeLevel renders no initiative line', () => {
      const policy: BehaviorPolicy = {
        channels: { groupChat: { proactivePolicy: { initiativeLevel: 'passive' } } }
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
      globalPolicy: { guardrails: ['Never speculate about participants'] },
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
    const dmGoals = loadGoals(['private_reassure'])
    expect(buildGoalInstructions(dmGoals, 'groupChat')).toBe('')
  })

  test('renders groupChat goal with label and description', () => {
    const goals = loadGoals(['provoke_participation'])
    const result = buildGoalInstructions(goals, 'groupChat')
    expect(result).toContain('## Active Behavioral Patterns')
    expect(result).toContain('### Provoke participation')
    expect(result).toContain('Generates energy')
  })

  test('renders trigger conditions', () => {
    const goals = loadGoals(['provoke_participation'])
    const result = buildGoalInstructions(goals, 'groupChat')
    expect(result).toContain('Trigger when:')
    expect(result).toContain('participation is low')
  })

  test('renders guardrails', () => {
    const goals = loadGoals(['provoke_participation'])
    const result = buildGoalInstructions(goals, 'groupChat')
    expect(result).toContain('Guardrails:')
    expect(result).toContain("don't introduce provocation")
  })

  test('renders examples', () => {
    const goals = loadGoals(['provoke_participation'])
    const result = buildGoalInstructions(goals, 'groupChat')
    expect(result).toContain('Examples:')
    expect(result).toContain("Playing devil's advocate")
  })

  test('renders dm goal when channelType is dm', () => {
    const goals = loadGoals(['private_reassure'])
    const result = buildGoalInstructions(goals, 'dm')
    expect(result).toContain('### Reassure privately')
  })

  test('filters out dm goals when channelType is groupChat', () => {
    const goals = loadGoals(['provoke_participation', 'private_reassure'])
    const result = buildGoalInstructions(goals, 'groupChat')
    expect(result).toContain('Provoke participation')
    expect(result).not.toContain('Reassure privately')
  })

  test('renders multiple goals', () => {
    const goals = loadGoals(['provoke_participation', 'bridge_topics'])
    const result = buildGoalInstructions(goals, 'groupChat')
    expect(result).toContain('### Provoke participation')
    expect(result).toContain('### Bridge topics')
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
    const policy: BehaviorPolicy = { globalPolicy: { tone: 'professional' } }
    const result = composeSystemPrompt('Base.', { behaviorPolicy: policy })
    expect(result).toContain('## Behavioral Guidelines')
  })

  test('appends goal instructions when goals and channelType provided', () => {
    const goals = loadGoals(['provoke_participation'])
    const result = composeSystemPrompt('Base.', { goals, channelType: 'groupChat' })
    expect(result).toContain('## Active Behavioral Patterns')
  })

  test('does not append goal instructions when channelType is missing', () => {
    const goals = loadGoals(['provoke_participation'])
    const result = composeSystemPrompt('Base.', { goals })
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
    const policy: BehaviorPolicy = { globalPolicy: { tone: 'clearNeutral' } }
    const result = composeSystemPrompt('Base.', { behaviorPolicy: policy })
    expect(result).toContain('Base.\n\n')
  })

  test('composes all parts in canonical order: base → context → policy → goals → personality', () => {
    const ctx: ConversationContext = { conversationType: 'summit' }
    const policy: BehaviorPolicy = { globalPolicy: { tone: 'clearNeutral' } }
    const goals = loadGoals(['provoke_participation'])
    const result = composeSystemPrompt('Base.', {
      conversationContext: ctx,
      behaviorPolicy: policy,
      goals,
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
