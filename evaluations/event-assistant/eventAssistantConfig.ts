/**
 * Event Assistant Evaluation Configuration
 *
 * This configuration is specific to the Event Assistant agent.
 * It includes custom evaluation prompts and evaluation type definitions.
 */

import { initializeEvaluators } from '../../tests/utils/evaluators.js'

// Event Assistant-specific evaluation prompts
// Note: Personality prompts are handled by evaluators.ts defaults
// Only override if you need EA-specific versions

const correctnessPrompt = `You are an expert data labeler evaluating model outputs for correctness. Your task is to assign a score based on the following rubric:

<Rubric>
A correct answer:
- Provides accurate information, prioritizing the provided context when available
- When context contains the answer: uses only context-based information without fabrication
- When context lacks the answer: appropriately uses general knowledge and clearly indicates sources or uncertainty
- Contains no factual errors in either context-based or general knowledge claims
- Addresses all parts of the question appropriately
- Suggests relevant resources or places to find additional information when helpful
- Is logically consistent and uses precise terminology

When scoring, you should penalize:
- Factual errors or inaccuracies (whether from context or general knowledge)
- Incomplete answers when information *is* present in context
- Misleading or ambiguous statements
- Incorrect terminology or logical inconsistencies
- Missing key information available in the provided context
- Failure to distinguish between context-based and general knowledge when both are used
- Unhelpful responses that don't attempt to provide useful information or guidance
</Rubric>

<input>
{inputs}
</input>

<output>
{outputs}
</output>

<context>
{context}
</context>

<reference_outputs>
{reference_outputs}
</reference_outputs>
`

const concisenessPrompt = `You are an expert data labeler evaluating model outputs for conciseness. Your task is to assign a score based on the following rubric:

<Rubric>
A perfectly concise answer:
- Contains only the exact information requested
- Uses the minimum number of words necessary to convey the complete answer
- Omits pleasantries, hedging language, and unnecessary context
- Excludes meta-commentary about the answer or the model's capabilities
- Avoids redundant information or restatements
- Does not include explanations unless explicitly requested

Special cases for maximum conciseness (score = 1.0):
- Hard-coded off-topic responses should always receive maximum score as they are the intended system response
- Brief, clear source attributions and resource suggestions are considered essential information, not extraneous content
</Rubric>

<input>
{inputs}
</input>

<output>
{outputs}
</output>

<context>
{context}
</context>

<reference_outputs>
{reference_outputs}
</reference_outputs>`

const helpfulnessPrompt = `You are an expert data labeler evaluating how helpful a response is for a participant in a live event.

<Rubric>
A helpful response:
- Directly addresses what the participant is asking or expressing, using the available event context
- When the question contains ambiguous pronouns ("she", "he", "they") or references ("this meeting", "this talk"), assumes they refer to the current speaker or event — do not penalize the agent for resolving these references using context
- Provides substantive information drawn from the event transcript or context rather than asking for clarification that the agent can resolve itself
- Is appropriately detailed for the question's scope

An unhelpful response:
- Fails to address what the participant is actually asking
- Asks for clarification on things the agent could reasonably infer from the event context
- Provides generic or evasive answers when the transcript contains relevant information
</Rubric>

<Instructions>
- The agent is participating in a live event and has access to the current speaker's transcript as context
- Treat ambiguous references ("she", "this meeting", "what she said") as referring to the current speaker and event unless the context makes another interpretation clearly more likely
- Evaluate whether the response usefully addresses the participant's need given that context
- Do not penalize the agent for assuming "she" means the speaker or "this meeting" means the current event
</Instructions>

<input>
{inputs}
</input>

<output>
{outputs}
</output>

<context>
{context}
</context>`

const groundednessPrompt = `You are an expert data labeler evaluating whether a model output is grounded in the provided context.

<Rubric>
A grounded response:
- Makes only claims that are supported by or inferable from the provided context
- Does not introduce facts, statistics, or details that contradict or go beyond the context

An ungrounded response:
- Makes substantive factual claims about the topic that are not supported by the context
- Contradicts information present in the context

Special case — conversational or deflecting responses (score = 1.0):
- If the output makes no substantive claims about the topic (e.g. a polite acknowledgment, a redirection, or a response to disengagement like "not every talk resonates — feel free to ask something else"), it cannot be ungrounded. Score these as 1.0.
- Groundedness only applies to factual claims. A response that makes no claims is fully grounded by definition.
</Rubric>

<Instructions>
- Identify all substantive factual claims in the output
- If there are none (conversational, deflecting, or off-topic acknowledgment responses), return 1.0
- For each factual claim, check whether it is supported by the context
- Penalize only for unsupported or contradictory claims, not for omissions
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

const retrievalRelevancePrompt = `You are an expert data labeler evaluating retrieved context for relevance to the input.

<Rubric>
Relevant retrieved context:
- Contains information that could help answer the input, even if incomplete
- May include superfluous information, but should still be somewhat related to the input

Irrelevant retrieved context:
- Contains no useful information for answering the input
- Is entirely unrelated to the input
- Contains only tangentially related information with no practical utility

Special case — no retrieved context:
- If the ## Relevant Retrieved Context section is empty or absent, consider whether the question actually required retrieval.
- For conversational, off-topic, or disengagement responses where retrieval would not have helped, score as 1.0.
- For substantive questions about the event where relevant transcript content likely exists, treat missing retrieval as a gap and score accordingly.
</Rubric>

<Instructions>
- The context field may contain multiple sections. Focus ONLY on the section under the ## Relevant Retrieved Context header.
- Ignore the recent transcript and any other sections — they are not part of the retrieval being evaluated.
- If there is no ## Relevant Retrieved Context section or it is empty, return 1.0.
- Evaluate only whether the retrieved chunks are topically relevant to the input.
</Instructions>

<input>
{inputs}
</input>

<retrieved_context>
{context}
</retrieved_context>`

const personalityEvaluators = [
  'conciseness',
  'ceremony',
  'leadWithAnswer',
  'antiSycophancy',
  'pragmatic',
  'opinionatedBounded',
  'confidentNotCocky',
  'witAndHumor',
  'honestyAboutLimits'
]

// Evaluation type configurations
export const evaluationTypes = {
  semantic: {
    name: 'Semantic Response',
    evaluators: [
      ...personalityEvaluators,
      'correctness',
      'hallucination',
      'groundedness',
      'helpfulness',
      'retrievalRelevance'
    ]
  },
  timeWindow: {
    name: 'Time Window Response',
    evaluators: [...personalityEvaluators, 'correctness', 'hallucination', 'groundedness']
  },
  webSearch: {
    name: 'Web Search Response',
    evaluators: [...personalityEvaluators, 'correctness', 'helpfulness']
  }
}

/**
 * Initialize evaluators with Event Assistant-specific custom prompts
 */
export async function initializeAgentEvaluators() {
  await initializeEvaluators({
    correctness: correctnessPrompt,
    conciseness: concisenessPrompt,
    groundedness: groundednessPrompt,
    helpfulness: helpfulnessPrompt,
    retrievalRelevance: retrievalRelevancePrompt
  })
}
