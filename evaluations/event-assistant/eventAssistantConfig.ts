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
  timewindow: {
    name: 'Time Window Response',
    evaluators: [...personalityEvaluators, 'correctness', 'hallucination', 'groundedness']
  }
}

/**
 * Initialize evaluators with Event Assistant-specific custom prompts
 */
export async function initializeAgentEvaluators() {
  await initializeEvaluators({
    correctness: correctnessPrompt,
    conciseness: concisenessPrompt
  })
}
