import { z } from 'zod'
import { getChatPromptResponse } from './llmChain.js'
import logger from '../../config/logger.js'

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

export interface SocraticQuestionVerdict {
  valid: boolean
  reason?: string
}

/**
 * Judge: tries to extract any finding the message implies from the passage. Any non-empty
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
      return { valid: false, reason: `it implies a finding from the reading (${result.impliedFindings.join(' | ')})` }
    }
    return { valid: true }
  } catch (error) {
    logger.error('[SocraticGuardrail] Extraction error, failing closed', error)
    return { valid: false, reason: 'the finding extraction could not be completed' }
  }
}
