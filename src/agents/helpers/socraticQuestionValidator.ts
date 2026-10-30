import { z } from 'zod'
import { getChatPromptResponse } from './llmChain.js'
import logger from '../../config/logger.js'

const SocraticQuestionSchema = z.object({
  reasoning: z.string().describe('Brief analysis of whether the message reveals anything the passage found or concluded.'),
  revealsFinding: z.boolean().describe('True if the message asserts a finding, number, or outcome from the passage as fact')
})

type SocraticQuestionAnalysis = z.infer<typeof SocraticQuestionSchema>

const ExtractionSchema = z.object({
  impliedFindings: z
    .array(z.string())
    .describe(
      'Every finding, number, or outcome from the passage that the message states or lets a reader infer. Empty if none.'
    )
})

const EXTRACT_SYSTEM_PROMPT = `You audit a facilitator's question for leaks of a reading's findings.

Given a reading passage and a facilitator message, list every finding, number, or outcome from the passage that the message states, paraphrases, or lets a reader infer (for example a question that presupposes the result: "why did replies fall once quotas arrived?" implies replies fell).

A message that only names the source, names a concept or term, or asks open-endedly how the source treats something implies NO finding. Return an empty list for those.

## Output Format
{{
  "impliedFindings": [list of strings, empty if none]
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const EXTRACT_USER_PROMPT = `Reading passage:
{passage}

Facilitator message:
"{message}"

List any finding, number, or outcome from the passage that the message states or implies.`

const SYSTEM_PROMPT = `You check a facilitator's question against the reading passage it was drawn from.

The facilitator may name the source, the topic or concept the passage covers, and use the passage's own terms. It must NOT state what the passage found. Flag the message only if it asserts a finding, number, or outcome from the passage as fact, e.g. "the study found replies fell by a third" or "participation recovered after quotas were dropped", whether in a lead-in or inside the question.

Do NOT flag open questions that ask what the source says or found, or how it treats a topic or word (e.g. "what happened to the quality of replies when quotas were introduced?" only asks, and reveals nothing). Do NOT flag merely naming the author, title, or concept.

## Output Format
{{
  "reasoning": brief analysis,
  "revealsFinding": boolean
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const USER_PROMPT = `Reading passage:
{passage}

Facilitator message:
"{message}"

Does the message assert a finding, number, or outcome from the passage as fact?`

export interface SocraticQuestionVerdict {
  valid: boolean
  reason?: string
}

/**
 * Judge (a): does the message assert a finding, number, or outcome from the passage as fact? Fails
 * CLOSED: an LLM error counts as invalid, because the only safe alternative to a question we could
 * not check is silence or a template.
 */
export default async function validateSocraticQuestion(
  llm,
  message: string,
  passage: string
): Promise<SocraticQuestionVerdict> {
  const text = message.trim()
  try {
    const analysis = (await getChatPromptResponse(
      llm,
      SYSTEM_PROMPT,
      USER_PROMPT,
      { passage, message: text },
      [],
      SocraticQuestionSchema
    )) as SocraticQuestionAnalysis

    if (analysis.revealsFinding) {
      logger.warn(`[SocraticGuardrail] Rejected message: ${text}. Reason: ${analysis.reasoning}`)
      return { valid: false, reason: `it reveals what the reading found (${analysis.reasoning})` }
    }
    return { valid: true }
  } catch (error) {
    logger.error('[SocraticGuardrail] Validation error, failing closed', error)
    return { valid: false, reason: 'the finding check could not be completed' }
  }
}

/**
 * Judge (b): tries to extract any finding the message implies from the passage. Any non-empty
 * result rejects. Fails CLOSED on LLM errors.
 */
export async function extractImpliedFindings(llm, message: string, passage: string): Promise<SocraticQuestionVerdict> {
  const text = message.trim()
  try {
    const result = (await getChatPromptResponse(
      llm,
      EXTRACT_SYSTEM_PROMPT,
      EXTRACT_USER_PROMPT,
      { passage, message: text },
      [],
      ExtractionSchema
    )) as z.infer<typeof ExtractionSchema>

    if (result.impliedFindings.some((f) => f.trim())) {
      logger.warn(
        `[SocraticGuardrail] Implied findings in message: ${text}. Findings: ${result.impliedFindings.join(' | ')}`
      )
      return { valid: false, reason: 'it implies a finding from the reading' }
    }
    return { valid: true }
  } catch (error) {
    logger.error('[SocraticGuardrail] Extraction error, failing closed', error)
    return { valid: false, reason: 'the finding extraction could not be completed' }
  }
}
