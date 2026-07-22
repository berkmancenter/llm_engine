import { BehaviorPolicy, GroupChatPolicy, ConversationContext, ConversationGoal } from '../../types/index.types.js'
import { loadGoals, getDmGoals, getGroupChatGoals } from '../../goals/loader.js'
import { getPersonalityByName } from './agentPersonality.js'

const TONE_LINES = {
  clearNeutral: '- Voice: clear and neutral — precise, even-handed, no editorializing',
  warmSupportive:
    '- Voice: warm and supportive — two registers available: warm (vulnerable themes, minority perspectives) and witty (transitions, lulls, callbacks). Default to warm. Never be sarcastic about participants.',
  playful: "- Voice: playful — wit, energy, personality. Keep it warm; never at a participant's expense",
  professional: '- Voice: professional — measured, authoritative, no wit'
}

const FORMALITY_LINES = {
  casual: '- Casual, conversational register',
  semiFormal: '- Semi-formal register; your personality shows through, calibrated to the setting',
  formal: '- Formal register; professional and precise'
}

const VERBOSITY_LINES = {
  brief: '- Keep responses brief — one or two sentences where possible',
  medium: '- Medium length responses — thorough but not exhaustive',
  detailed: '- Detailed responses — do not sacrifice completeness for brevity'
}

const RESPONSE_LENGTH_LINES: Record<string, string> = {
  short: '- Keep answers short — one to two sentences',
  medium: '- Medium length answers — cover what is needed without going into exhaustive detail',
  long: '- Give thorough, detailed answers — completeness is more important than brevity'
}

const JARGON_LINES: Record<string, string> = {
  low: '- Clear, accessible language — explain jargon rather than assuming familiarity',
  lowToMedium: '- Clear, accessible language — explain jargon rather than assuming familiarity',
  medium: '- Balanced language — use domain terms where natural but briefly clarify less common ones',
  high: '- Technical language is appropriate for this audience'
}

const INITIATIVE_LINES: Record<string, string> = {
  lightlyProactive: '- Intervene sparingly — only when the signal is clear',
  moderatelyProactive: '- Intervene regularly when you see an opportunity',
  highlyProactive: '- Participate actively and frequently'
}

const QA_SCOPE_LINES: Record<string, string> = {
  companyContextOnly: '- Limit answers to company or internal context only',
  helpUserUnderstandTheLecture: '- Focus answers on helping the participant understand the content being presented',
  broaderSubjectArea: '- You may draw on the broader subject area when it helps the participant'
}

/**
 * Returns goals from the goals list that are eligible given channel and hard constraints.
 * pollPolicy.allowed: false removes poll_reveal regardless of goals.
 */
function getEligibleGoals(goals: string[] | undefined, groupChatPolicy?: GroupChatPolicy): ConversationGoal[] {
  if (!goals || goals.length === 0) return []

  let goalIds = [...goals]

  if (groupChatPolicy?.pollPolicy?.allowed === false) {
    goalIds = goalIds.filter((id) => id !== 'poll_reveal')
  }

  try {
    return loadGoals(goalIds)
  } catch {
    return []
  }
}

/**
 * Returns the confidence threshold to apply for an intervention.
 * High social sensitivity raises the default from 60 to 75.
 * Per-goal minConfidence is a floor applied by the caller.
 */
function getConfidenceThreshold(proactivePolicy?: { socialSensitivity?: 'low' | 'medium' | 'high' }): number {
  if (proactivePolicy?.socialSensitivity === 'high') return 75
  return 60
}

/**
 * Returns the minimum interval between interventions in milliseconds.
 * Falls back to agentConfig.minInterval (in minutes) if policy is not set.
 */
function getMinContributionMs(
  proactivePolicy?: { minContributionMinutes?: number },
  agentConfig?: { minInterval?: number }
): number {
  const minutes = proactivePolicy?.minContributionMinutes ?? agentConfig?.minInterval ?? 2
  return minutes * 60 * 1000
}

/**
 * Generates the event context section of a system prompt from a ConversationContext.
 * Returns an empty string if no conversationType is set.
 */
function buildConversationContextSection(conversationContext: ConversationContext | undefined): string {
  if (!conversationContext?.conversationType) return ''

  const lines: string[] = ['## Event Context']
  const { conversationType, purpose } = conversationContext
  const desc = purpose
    ? `This is a ${conversationType.toLowerCase()}. Purpose: ${purpose}.`
    : `This is a ${conversationType.toLowerCase()}.`
  lines.push(desc)

  if (conversationContext.audience) {
    const a = conversationContext.audience
    const parts: string[] = []
    if (a.expertiseLevel) parts.push(`${a.expertiseLevel} expertise level`)
    if (a.type && a.type.length > 0) parts.push(a.type.join(', '))
    if (a.assumedBackgroundKnowledge) parts.push(`${a.assumedBackgroundKnowledge} background knowledge assumed`)
    if (parts.length > 0) lines.push(`Audience: ${parts.join(' — ')}.`)
    if (a.description) lines.push(a.description)
  }

  if (conversationContext.contentSensitivity) {
    const cs = conversationContext.contentSensitivity
    const sensitivityLines: string[] = ['Content sensitivity:']
    if (cs.level && cs.level !== 'standard') {
      sensitivityLines.push(`- Level: ${cs.level} — apply extra care with how you frame interventions`)
    }
    if (cs.domains && cs.domains.length > 0) {
      sensitivityLines.push(`- Sensitive domains: ${cs.domains.join(', ')} — avoid editorializing, taking sides, or making light of these topics`)
    }
    lines.push(sensitivityLines.join('\n'))
  }

  return lines.join('\n')
}

/**
 * Generates the behavioral guidelines section of a system prompt from a BehaviorPolicy.
 * Returns an empty string if the policy produces no guidelines.
 */
function buildBehaviorPolicySection(behaviorPolicy: BehaviorPolicy | undefined, channelType: 'dm' | 'groupChat'): string {
  if (!behaviorPolicy) return ''

  const lines: string[] = ['## Behavioral Guidelines']
  const gp = behaviorPolicy.globalPolicy

  if (gp) {
    if (gp.tone) lines.push(TONE_LINES[gp.tone])
    if (gp.formality) lines.push(FORMALITY_LINES[gp.formality])
    if (gp.verbosity) lines.push(VERBOSITY_LINES[gp.verbosity])
    const jargonLine = gp.jargonLevel && JARGON_LINES[gp.jargonLevel]
    if (jargonLine) lines.push(jargonLine)
    if (gp.citationBehavior) lines.push(`- ${gp.citationBehavior}`)
    if (gp.uncertaintyBehavior) lines.push(`- ${gp.uncertaintyBehavior}`)
  }

  const channelPolicy = channelType === 'dm' ? behaviorPolicy.channels?.dm : behaviorPolicy.channels?.groupChat

  if (channelType === 'dm' && behaviorPolicy.channels?.dm?.qaBehavior) {
    const qa = behaviorPolicy.channels.dm.qaBehavior
    const responseLengthLine = RESPONSE_LENGTH_LINES[qa.responseLength]
    if (responseLengthLine) lines.push(responseLengthLine)
    if (qa.clarifyWhenAmbiguous) lines.push('- Ask a clarifying question before answering when the question is ambiguous')
    if (qa.addContextWhenUseful) lines.push('- Add bridging context when it would help a non-expert audience')
    if (qa.allowFollowUpDialogue) lines.push('- You may invite continued dialogue if it would be useful')
    const scopeLine = QA_SCOPE_LINES[qa.answerScope]
    if (scopeLine) lines.push(scopeLine)
  }

  const initiativeLine = channelPolicy?.proactivePolicy?.initiativeLevel
  if (initiativeLine && INITIATIVE_LINES[initiativeLine]) lines.push(INITIATIVE_LINES[initiativeLine])

  const channelGuardrails =
    channelType === 'groupChat'
      ? behaviorPolicy.channels?.groupChat?.guardrails
      : behaviorPolicy.channels?.dm?.guardrails
  const allGuardrails = [...(gp?.guardrails ?? []), ...(channelGuardrails ?? [])]
  if (allGuardrails.length > 0) {
    lines.push('Guardrails:')
    for (const g of allGuardrails) lines.push(`- ${g}`)
  }

  return lines.length > 1 ? lines.join('\n') : ''
}

/**
 * Generates the active goal instructions section of a system prompt.
 * Each goal contributes its description, trigger conditions, guardrails, and examples.
 */
function buildGoalInstructions(goals: ConversationGoal[], channelType: 'dm' | 'groupChat'): string {
  const channelGoals = channelType === 'groupChat' ? getGroupChatGoals(goals) : getDmGoals(goals)
  if (channelGoals.length === 0) return ''

  const lines: string[] = ['## Active Behavioral Patterns']
  lines.push(
    'The following patterns define when and how you should act. Choose the most appropriate pattern when conditions are met. When in doubt, remain silent.\n'
  )

  for (const goal of channelGoals) {
    lines.push(`### ${goal.label}`)
    lines.push(goal.description)

    if (goal.triggers.conditions.length > 0) {
      lines.push(`\nTrigger when: ${goal.triggers.conditions.map((c) => c.condition).join('; ')}.`)
    }

    if (goal.guardrails.length > 0) {
      lines.push('\nGuardrails:')
      for (const g of goal.guardrails) {
        lines.push(`- ${g}`)
      }
    }

    if (goal.examples.length > 0) {
      lines.push('\nExamples:')
      for (const ex of goal.examples) {
        lines.push(`- ${ex}`)
      }
    }

    lines.push('')
  }

  return lines.join('\n').trim()
}

/**
 * Composes a full system prompt from its parts in the canonical order:
 *   base → behavioral policy section → goal instructions → personality
 *
 * Any combination of optional parts may be omitted.
 */
function composeSystemPrompt(
  basePrompt: string,
  options: {
    conversationContext?: ConversationContext
    behaviorPolicy?: BehaviorPolicy
    goals?: ConversationGoal[]
    channelType?: 'dm' | 'groupChat'
    personalityName?: string | null
  } = {}
): string {
  const { conversationContext, behaviorPolicy, goals, channelType, personalityName } = options
  const parts: string[] = [basePrompt]

  const contextSection = buildConversationContextSection(conversationContext)
  if (contextSection) parts.push(contextSection)

  const policySection = buildBehaviorPolicySection(behaviorPolicy, channelType ?? 'groupChat')
  if (policySection) parts.push(policySection)

  if (goals && goals.length > 0 && channelType) {
    const goalSection = buildGoalInstructions(goals, channelType)
    if (goalSection) parts.push(goalSection)
  }

  if (personalityName) {
    const personality = getPersonalityByName(personalityName)
    if (personality) parts.push(personality.promptSection)
  }

  return parts.join('\n\n')
}

export {
  getEligibleGoals,
  getConfidenceThreshold,
  getMinContributionMs,
  buildConversationContextSection,
  buildBehaviorPolicySection,
  buildGoalInstructions,
  composeSystemPrompt
}
