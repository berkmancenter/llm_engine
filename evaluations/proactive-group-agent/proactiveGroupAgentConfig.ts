/* eslint-disable @typescript-eslint/no-explicit-any */

import { createLLMAsJudge } from 'openevals'
import { getModelChat } from '../../src/agents/helpers/getModelChat.js'

export { ConversationTemplate, TEMPLATES } from '../templates.js'

// ---------------------------------------------------------------------------
// Evaluator registry
// ---------------------------------------------------------------------------

export const evaluators: Record<string, any> = {
  toneComplianceEvaluator: null,
  formalityComplianceEvaluator: null,
  audienceAppropriatenessEvaluator: null,
  verbosityComplianceEvaluator: null,
  contentSensitivityComplianceEvaluator: null,
  interventionAppropriatenessEvaluator: null
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const TONE_COMPLIANCE_PROMPT = `Evaluate whether the agent message matches the specified tone policy.

<Rubric>
Score 1.0 if: The message clearly matches the specified tone (e.g. warm and supportive when policy is warmSupportive; measured and authoritative when professional; energetic and witty when playful).
Score 0.5 if: The message is broadly appropriate but tone cues are weak or inconsistent.
Score 0.0 if: The message clearly contradicts the specified tone (e.g. sarcastic jokes in a professional setting, or flat neutral language when warmth is required).
</Rubric>

<Instructions>
The tone policy is specified in the context field as one of: clearNeutral, warmSupportive, playful, professional.
The agent also has a "sarcastic-expert" personality modifier that adds wit, brevity, and dry humor on top of the base tone policy.
Evaluate the *combination*: the message should honour the underlying tone policy while the personality modifier may add edge or economy of expression.
Score 0.0 only if the personality modifier actively undermines the tone policy — e.g. sarcasm that creates coldness in a warmSupportive context, or mockery in a professional one.
Do not penalise wit or brevity that is consistent with the tone policy.
</Instructions>

<context>
{context}
</context>

<input>
{inputs}
</input>

<output>
{outputs}
</output>`

const FORMALITY_COMPLIANCE_PROMPT = `Evaluate whether the agent message matches the specified formality level.

<Rubric>
Score 1.0 if: The message clearly matches the specified formality (e.g. conversational contractions and casual phrasing for casual; structured and precise for formal; personality showing through for semiFormal).
Score 0.5 if: Formality level is broadly appropriate but inconsistent.
Score 0.0 if: The message clearly contradicts the specified formality.
</Rubric>

<Instructions>
The formality policy is specified in the context field as one of: casual, semiFormal, formal.
Focus on vocabulary choices, sentence structure, and use of contractions.
</Instructions>

<context>
{context}
</context>

<input>
{inputs}
</input>

<output>
{outputs}
</output>`

const AUDIENCE_APPROPRIATENESS_PROMPT = `Evaluate whether the agent message is pitched at the right level for the specified audience.

<Rubric>
Score 1.0 if: Vocabulary, assumed background knowledge, and scaffolding clearly match the audience description (e.g. accessible language and definitions for beginners; technical shorthand appropriate for experts; mixed register for mixed audiences).
Score 0.5 if: Broadly appropriate but with some mismatch — e.g. a term that would confuse beginners left unexplained, or unnecessary scaffolding for an expert audience.
Score 0.0 if: Clearly mismatched — jargon-heavy for a beginner audience, or over-explained and condescending for experts.
</Rubric>

<Instructions>
The audience profile and conversation type are specified in the context field.
Evaluate whether the output's vocabulary, sentence structure, and assumed background knowledge fit that audience.
If the output is "NO_INTERVENTION", score 1.0 — staying silent is always appropriate.
</Instructions>

<context>
{context}
</context>

<input>
{inputs}
</input>

<output>
{outputs}
</output>`

const VERBOSITY_COMPLIANCE_PROMPT = `Evaluate whether the agent message matches the specified verbosity policy.

<Rubric>
Score 1.0 if: The message length clearly matches the policy — one or two sentences for brief; a fuller but not exhaustive response for medium; comprehensive coverage for detailed.
Score 0.5 if: Length is broadly appropriate but slightly off — a brief policy met with three sentences, or a medium policy met with a single terse line.
Score 0.0 if: The message clearly violates the policy — a multi-paragraph response when brief was required, or a single clipped sentence when medium or detailed was expected.
</Rubric>

<Instructions>
The verbosity policy is specified in the context field as one of: brief, medium, detailed.
If the output is "NO_INTERVENTION", score 1.0 — length is irrelevant when the agent stays silent.
Judge only on length and completeness relative to the policy. Do not penalise for tone or content.
</Instructions>

<context>
{context}
</context>

<input>
{inputs}
</input>

<output>
{outputs}
</output>`

const CONTENT_SENSITIVITY_COMPLIANCE_PROMPT = `Evaluate whether the agent message respects the content sensitivity settings for this event.

<Rubric>
Score 1.0 if: The message handles sensitive domains with appropriate care — no editorializing, no taking sides, no making light of the topic — OR no content sensitivity is specified and the message is appropriate.
Score 0.5 if: The message is broadly appropriate but contains a phrase or framing that could be seen as subtly editorializing or insufficiently careful given the sensitivity level.
Score 0.0 if: The message clearly violates the sensitivity setting — takes a position on a contested topic, makes light of a sensitive domain, or frames a sensitive issue in a way that could alienate participants.
</Rubric>

<Instructions>
The content sensitivity level and sensitive domains are specified in the context field.
If content sensitivity is "none" or "standard" and no domains are listed, score 1.0 unless the message is obviously inappropriate.
For elevated or high sensitivity: check that the message does not editorialize, take sides, or frame sensitive topics carelessly.
If the output is "NO_INTERVENTION", score 1.0 — staying silent always respects sensitivity.
</Instructions>

<context>
{context}
</context>

<input>
{inputs}
</input>

<output>
{outputs}
</output>`

const INTERVENTION_APPROPRIATENESS_PROMPT = `Evaluate whether the agent's decision to intervene (or stay silent) was appropriate given the state of the conversation.

<Rubric>
Score 1.0 if: The agent intervened at a moment where participants were passive, silent, or genuinely needed facilitation — OR correctly stayed silent while participants were actively and substantively exchanging messages.
Score 0.5 if: The intervention was borderline — not clearly warranted but not clearly harmful.
Score 0.0 if: The agent interrupted an active, healthy discussion that needed no facilitation, or failed to act on a clear pattern that warranted intervention.
</Rubric>

<Instructions>
The conversation state (transcript excerpt, shared chat messages) is in the context field.
The output is the agent's message, or "NO_INTERVENTION" if the agent stayed silent.
Judge based on whether the trigger conditions were genuinely met.
</Instructions>

<context>
{context}
</context>

<input>
{inputs}
</input>

<output>
{outputs}
</output>`

// ---------------------------------------------------------------------------
// Initializer
// ---------------------------------------------------------------------------

export async function initializeAgentEvaluators() {
  const judge = (await getModelChat('openai', 'gpt-5.2-2025-12-11', {})) as any

  evaluators.toneComplianceEvaluator = createLLMAsJudge({
    prompt: TONE_COMPLIANCE_PROMPT,
    continuous: true,
    feedbackKey: 'toneCompliance',
    judge
  })
  evaluators.formalityComplianceEvaluator = createLLMAsJudge({
    prompt: FORMALITY_COMPLIANCE_PROMPT,
    continuous: true,
    feedbackKey: 'formalityCompliance',
    judge
  })
  evaluators.audienceAppropriatenessEvaluator = createLLMAsJudge({
    prompt: AUDIENCE_APPROPRIATENESS_PROMPT,
    continuous: true,
    feedbackKey: 'audienceAppropriateness',
    judge
  })
  evaluators.verbosityComplianceEvaluator = createLLMAsJudge({
    prompt: VERBOSITY_COMPLIANCE_PROMPT,
    continuous: true,
    feedbackKey: 'verbosityCompliance',
    judge
  })
  evaluators.contentSensitivityComplianceEvaluator = createLLMAsJudge({
    prompt: CONTENT_SENSITIVITY_COMPLIANCE_PROMPT,
    continuous: true,
    feedbackKey: 'contentSensitivityCompliance',
    judge
  })
  evaluators.interventionAppropriatenessEvaluator = createLLMAsJudge({
    prompt: INTERVENTION_APPROPRIATENESS_PROMPT,
    continuous: true,
    feedbackKey: 'interventionAppropriateness',
    judge
  })
}
