/* eslint-disable @typescript-eslint/no-explicit-any */

import { createSharedEvaluators, createJudge } from '../sharedEvaluators.js'

export { ConversationTemplate, TEMPLATES } from '../templates.js'

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
  contentSensitivityComplianceEvaluator: null
}

// ---------------------------------------------------------------------------
// Initializer
// ---------------------------------------------------------------------------

export async function initializeAgentEvaluators() {
  const judge = await createJudge()
  Object.assign(evaluators, await createSharedEvaluators(judge))
}
