/* eslint-disable @typescript-eslint/no-explicit-any */

import { createSharedEvaluators, createJudge } from '../sharedEvaluators.js'
import { BehaviorPolicy, ConversationContext } from '../../src/types/index.types.js'

// ---------------------------------------------------------------------------
// Evaluator registry
// ---------------------------------------------------------------------------

export const evaluators: Record<string, any> = {
  interventionAppropriatenessEvaluator: null,
  guardrailComplianceEvaluator: null,
  toneComplianceEvaluator: null,
  formalityComplianceEvaluator: null,
  audienceAppropriatenessEvaluator: null,
  verbosityComplianceEvaluator: null,
  contentSensitivityComplianceEvaluator: null,
  privacyProtectionEvaluator: null
}

export const EVALUATOR_NAMES = [
  'interventionAppropriateness',
  'guardrailCompliance',
  'toneCompliance',
  'formalityCompliance',
  'audienceAppropriateness',
  'verbosityCompliance',
  'contentSensitivityCompliance',
  'privacyProtection'
]

// Evaluators that only make sense when the agent sent a message
export const INTERVENTION_ONLY_EVALUATORS = new Set([
  'guardrailCompliance',
  'toneCompliance',
  'formalityCompliance',
  'audienceAppropriateness',
  'verbosityCompliance',
  'contentSensitivityCompliance'
])

// ---------------------------------------------------------------------------
// Judge context builder
// ---------------------------------------------------------------------------

export function makeJudgeContext(
  inputs: any,
  goalId: string,
  goalDescription: string,
  triggerConditions: string[],
  guardrails: string[],
  behaviorPolicy: BehaviorPolicy,
  conversationContext?: ConversationContext
) {
  const gp = behaviorPolicy.globalPolicy
  const dmPolicy = behaviorPolicy.channels?.dm?.proactivePolicy

  return [
    `Active goal: ${goalId}`,
    `Goal description: ${goalDescription}`,
    `Trigger conditions: ${triggerConditions.join('; ')}`,
    `Guardrails: ${guardrails.join('; ')}`,
    `Event type: ${conversationContext?.conversationType ?? 'not set'}`,
    `Audience (template default — individual DM signals take precedence for calibration): ${JSON.stringify(
      conversationContext?.audience ?? {}
    )}`,
    `Tone policy: ${gp?.tone ?? 'not set'}`,
    `Formality: ${gp?.formality ?? 'not set'}`,
    `Verbosity: ${gp?.verbosity ?? 'not set'}`,
    `DM initiative level: ${dmPolicy?.initiativeLevel ?? 'not set'}`,
    `DM social sensitivity: ${dmPolicy?.socialSensitivity ?? 'not set'}`,
    `Output channel: private DM sent only to the target participant — not visible to other participants or the group`,
    `Scenario: ${inputs.description ?? ''}`,
    `Participant DMs: ${JSON.stringify(inputs.participantDms ?? [])}`,
    `Other participant DMs: ${JSON.stringify(inputs.otherParticipantDms ?? [])}`,
    `Chat messages: ${JSON.stringify(inputs.chatMessages ?? [])}`,
    `Transcript messages: ${JSON.stringify(inputs.transcriptMessages ?? [])}`
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Initializer
// ---------------------------------------------------------------------------

export async function initializeAgentEvaluators() {
  const judge = await createJudge()
  Object.assign(evaluators, await createSharedEvaluators(judge))
}
