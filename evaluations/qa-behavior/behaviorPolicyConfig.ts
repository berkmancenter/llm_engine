/* eslint-disable @typescript-eslint/no-explicit-any */

import { createLLMAsJudge } from 'openevals'
import { BehaviorPolicy } from '../../src/types/index.types.js'
import { createJudge } from '../sharedEvaluators.js'

/**
 * LLM-as-judge prompt strings for qaBehavior policy evaluation.
 *
 * These are used by both the offline qa-behavior evaluation suite
 * (evaluations/qa-behavior/) and the post-event evaluator (postEventEval.ts).
 * Define prompts here; import from there.
 *
 * All rubrics use criteria-based language rather than fixed score anchors so the
 * judge assigns values across the full 0–1 range rather than snapping to 0/0.5/1.
 */

const responseLengthCompliancePrompt = `Evaluate how well the agent response matches the configured response length tier.

<Rubric>
A response that perfectly matches the tier:
- "short": 1–2 sentences covering the essential point — no elaboration, caveats, or closing remarks
- "medium": roughly 3–5 sentences of substance — enough to explain without being exhaustive
- "long": thorough, comprehensive coverage — goes well beyond a brief summary

When scoring, penalize only for content length relative to the tier — not for formatting choices like bullet points or line breaks. A well-formatted short response is still short.

- Exceeding the tier: padding, repetition, or detail beyond what the tier calls for
- Falling short of the tier: a bare one-liner when medium or long depth was expected
- Severity matters: a slight overshoot warrants a small penalty; a response three times the expected length warrants a large one

A clarifying question counts as short regardless of tier — the agent is gathering information before answering.
</Rubric>

<Instructions>
The configured responseLength tier is in the context field (one of: short, medium, long).
Judge only on length relative to that tier. Do not penalise for tone, content, or clarification behavior.
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

const answerScopeCompliancePrompt = `Evaluate how well the agent response respects the configured answer scope.

<Rubric>
A response that fully respects scope:
- "helpUserUnderstandTheLecture": content connects to the lecture material and does not venture into unrelated general knowledge
- "broaderSubjectArea": content may draw on the wider academic or professional domain beyond the specific lecture
- "companyContextOnly": content stays within the company's own context, policies, and situation — no general concepts or outside examples
- "open": content may address any topic the participant raises

When scoring, penalize:
- Scope violations: content that clearly falls outside what the configured scope permits (e.g. explaining general ML when companyContextOnly is set)
- Missed opportunities: staying narrowly lecture-bound when broaderSubjectArea would permit and benefit from a wider answer
- Partial violations: a mostly in-scope response with one off-topic tangent should lose less than a fully out-of-scope response

A clarifying question is always in scope — the agent is not yet answering substantively.
</Rubric>

<Instructions>
The configured answerScope is in the context field. Its meanings are defined in the rubric above.
Judge only on whether the content of the answer falls within the permitted scope. Do not penalise for clarification behavior or scaffolding — those are evaluated by separate dimensions.
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

const clarifyWhenAmiguousCompliancePrompt = `Evaluate how well the agent handles ambiguity per the configured clarification policy.

<Rubric>
Step 1 — Assess whether the question is genuinely ambiguous.
A question is genuinely ambiguous only if it could plausibly refer to two or more meaningfully different things and the intended meaning cannot be reasonably inferred from context. A clear question with a straightforward answer is NOT ambiguous even if it is broad or open-ended.

Step 2 — Score based on whether genuine ambiguity exists:

If the question is NOT genuinely ambiguous:
- Score 1.0 regardless of the clarifyWhenAmbiguous setting — the agent should answer directly and a clarifying question would be unnecessary friction

If the question IS genuinely ambiguous AND clarifyWhenAmbiguous is true:
- High score: asks a focused clarifying question before (or instead of) committing to one interpretation
- Penalize: answers directly without acknowledging the ambiguity at all — the severity of the penalty should scale with how much the ambiguity would matter
- Partial credit: agent hedges or notes multiple interpretations but answers anyway without asking — better than ignoring it entirely

If the question IS genuinely ambiguous AND clarifyWhenAmbiguous is false:
- High score: picks a reasonable interpretation and answers without asking the user to clarify
- Penalize: refuses to answer and asks for clarification instead
- Partial credit: answers but unnecessarily hedges with a clarifying question — mostly compliant but noisier than the policy intends
</Rubric>

<Instructions>
The configured clarifyWhenAmbiguous boolean is in the context field.
Judge only on whether the agent's handling of ambiguity aligns with the policy — not on the quality of the answer itself.
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

const addContextWhenUsefulComplianceReport = `Evaluate how well the agent calibrates bridging context to the configured policy.

<Rubric>
When addContextWhenUseful is true, a high-scoring response:
- Provides helpful background, analogies, or scaffolding alongside the direct answer — not just a bare definition
- The amount of context should match the apparent knowledge gap: more scaffolding for a clearly novice question, lighter touch for a simpler one
- Penalize: a bare answer with no contextualisation when the question clearly signals the participant lacks background
- Partial credit: the answer is present and mostly correct but the scaffolding is thin or generic

When addContextWhenUseful is false, a high-scoring response:
- Answers directly and efficiently without unsolicited explanatory padding
- Penalize: significant unsolicited background explanation that goes beyond what the question required
- Partial credit: minor contextual asides that are present but not seriously disruptive

A clarifying question scores well regardless — the agent is gathering information before deciding how much context is needed.
</Rubric>

<Instructions>
The configured addContextWhenUseful boolean and the audience profile are in the context field.
Evaluate ONLY whether the agent provided appropriate bridging context and scaffolding relative to the addContextWhenUseful setting.
Do NOT penalize or reward based on clarification behavior — whether the agent asked a clarifying question is evaluated by a separate dimension (clarifyWhenAmbiguous) and must not influence this score.
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

const followUpDialogueCompliancePrompt = `Evaluate how well the agent's response signals (or avoids signaling) openness to continued dialogue per the configured policy.

<Rubric>
When allowFollowUpDialogue is true, a high-scoring response:
- Closes with a clear, genuine invitation for the participant to ask more or continue the conversation
- The invitation should feel natural — e.g. "happy to go deeper on any of this" — not formulaic boilerplate
- Penalize: an abrupt ending that leaves no opening for further dialogue
- Partial credit: the response is warm and helpful but does not explicitly invite follow-up

When allowFollowUpDialogue is false, a high-scoring response:
- Concludes with a clean, task-focused close — the answer is complete and does not signal that more is welcome
- Penalize: explicitly inviting follow-up ("let me know if you have more questions", "feel free to ask") when the policy calls for a closed response
- Partial credit: a vague "hope that helps" that could be read either way — present but not a strong invitation

Evaluate the close of the response. The policy shapes tone and closure; it does not affect answer quality.
</Rubric>

<Instructions>
The configured allowFollowUpDialogue boolean is in the context field.
Judge only on the closing signal of the response — whether it invites or closes off further dialogue. Do not penalise for clarification behavior, content quality, or scaffolding.
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
// Evaluator registry
// ---------------------------------------------------------------------------

export const evaluators: Record<string, any> = {
  responseLengthComplianceEvaluator: null,
  answerScopeComplianceEvaluator: null,
  clarifyWhenAmbiguousComplianceEvaluator: null,
  addContextWhenUsefulComplianceEvaluator: null,
  followUpDialogueComplianceEvaluator: null
}

export const EVALUATOR_NAMES = [
  'responseLengthCompliance',
  'answerScopeCompliance',
  'clarifyWhenAmbiguousCompliance',
  'addContextWhenUsefulCompliance',
  'followUpDialogueCompliance'
]

// ---------------------------------------------------------------------------
// Judge context builder
// ---------------------------------------------------------------------------

export function makeJudgeContext(inputs: any, templateName: string, behaviorPolicy: BehaviorPolicy) {
  const qaBehavior = behaviorPolicy.channels?.dm?.qaBehavior
  const gp = behaviorPolicy.globalPolicy

  return [
    `Template: ${templateName}`,
    `Event: ${inputs.eventName ?? 'not set'}`,
    `Event description: ${inputs.eventDescription ?? 'not set'}`,
    `Participant question (DM): ${inputs.userQuestion}`,
    ``,
    `Configured qaBehavior:`,
    `  responseLength: ${qaBehavior?.responseLength ?? 'not set'}`,
    `  answerScope: ${qaBehavior?.answerScope ?? 'not set'}`,
    `  clarifyWhenAmbiguous: ${qaBehavior?.clarifyWhenAmbiguous ?? 'not set'}`,
    `  addContextWhenUseful: ${qaBehavior?.addContextWhenUseful ?? 'not set'}`,
    `  allowFollowUpDialogue: ${qaBehavior?.allowFollowUpDialogue ?? 'not set'}`,
    ``,
    `Global policy:`,
    `  tone: ${gp?.tone ?? 'not set'}`,
    `  formality: ${gp?.formality ?? 'not set'}`,
    `  verbosity: ${gp?.verbosity ?? 'not set'}`,
    `  jargonLevel: ${gp?.jargonLevel ?? 'not set'}`
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Initializer
// ---------------------------------------------------------------------------
const make = (judge: any) => (prompt: string, feedbackKey: string) =>
  createLLMAsJudge({ prompt, continuous: true, feedbackKey, judge })

function createQaBehaviorEvaluators(judge: any) {
  const m = make(judge)
  return {
    responseLengthComplianceEvaluator: m(responseLengthCompliancePrompt, 'responseLengthCompliance'),
    answerScopeComplianceEvaluator: m(answerScopeCompliancePrompt, 'answerScopeCompliance'),
    clarifyWhenAmbiguousComplianceEvaluator: m(clarifyWhenAmiguousCompliancePrompt, 'clarifyWhenAmbiguousCompliance'),
    addContextWhenUsefulComplianceEvaluator: m(addContextWhenUsefulComplianceReport, 'addContextWhenUsefulCompliance'),
    followUpDialogueComplianceEvaluator: m(followUpDialogueCompliancePrompt, 'followUpDialogueCompliance')
  }
}
export async function initializeAgentEvaluators() {
  const judge = await createJudge()
  Object.assign(evaluators, createQaBehaviorEvaluators(judge))
}
