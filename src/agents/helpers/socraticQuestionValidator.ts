import { z } from 'zod'
import { getChatPromptResponse } from './llmChain.js'
import logger from '../../config/logger.js'

const SpanSchema = z.object({
  span: z
    .string()
    .nullable()
    .describe('The exact words copied from the draft that state or presuppose a result from the passage, or null.')
})

const SYSTEM_PROMPT = `You check a facilitator's draft question against the reading passage it was drawn from.

Quote the exact words in the draft that state or presuppose a result from the passage, or return null.

Flag only an asserted or presupposed outcome, such as "why did replies fall?" or "since quotas hurt replies, ...". Copy the words from the draft character for character.

Do NOT flag:
- naming the source, its author, or its title;
- naming the concept, or using the passage's own terms;
- asking how the source treats, defines, or discusses something;
- any open question that does not assume what happened.

## Output Format
{{
  "span": "exact words from the draft" or null
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const USER_PROMPT = `Reading passage:
{passage}

Draft question:
"{message}"

Quote the words in the draft that state or presuppose a result from the passage, or return null.`

export interface SocraticQuestionVerdict {
  valid: boolean
  /** True when the judge could not run; the caller treats the draft as rejected. */
  error?: boolean
  reason?: string
}

export type SocraticJudgeMode = 'off' | 'span'

/** `SOCRATIC_JUDGE=off` skips the LLM judge (for ablations); anything else runs it. Read per call. */
export function socraticJudgeMode(): SocraticJudgeMode {
  return process.env.SOCRATIC_JUDGE?.trim().toLowerCase() === 'off' ? 'off' : 'span'
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** True when the quoted span really occurs in the draft (case, whitespace and punctuation ignored). */
export function spanOccursIn(span: string, draft: string): boolean {
  const needle = normalize(span)
  return needle.length > 0 && ` ${normalize(draft)} `.includes(` ${needle} `)
}

/**
 * Judge: asks the model to quote the words of the draft that state or presuppose a result. A quote
 * that is verifiably in the draft rejects it; no quote, or one that is not in the draft, passes. An
 * LLM error is reported as `error` (not a pass) so the caller can reject the draft.
 */
export default async function findAssertedResult(llm, message: string, passage: string): Promise<SocraticQuestionVerdict> {
  if (socraticJudgeMode() === 'off') return { valid: true }
  const text = message.trim()
  try {
    const result = (await getChatPromptResponse(
      llm,
      SYSTEM_PROMPT,
      USER_PROMPT,
      { passage, message: text },
      [],
      SpanSchema
    )) as z.infer<typeof SpanSchema>

    const span = result.span?.trim()
    if (span && spanOccursIn(span, text)) {
      return { valid: false, reason: `it states or presupposes a result: "${span}"` }
    }
    return { valid: true }
  } catch (error) {
    logger.error('[SocraticGuardrail] Judge error, treating the draft as rejected', error)
    return { valid: false, error: true, reason: 'the result check could not be completed' }
  }
}
