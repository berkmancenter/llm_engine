import logger from '../../config/logger.js'
import { checkSocraticShape, renderSocraticTemplate } from './socraticChecks.js'
import validateSocraticQuestion, { extractImpliedFindings } from './socraticQuestionValidator.js'
import writeSocraticQuestion, { RejectedDraft } from './socraticQuestionWriter.js'
import { SocraticSlots } from './socraticSlots.js'

/** One initial draft plus three redrafts, each a writer-only call. */
export const MAX_WRITER_ATTEMPTS = 4
/** Whole-stage budget; when it runs out the validated template is posted instead of going silent. */
export const SOCRATIC_STAGE_BUDGET_MS = 45_000

// Rejection reasons from the LLM judges can quote the passage, so the writer only ever gets this.
const GENERIC_LEAK_REASON = 'it stated or implied a result from the source; only ask how the source treats the concept'

export interface SocraticStageInput {
  llm: unknown
  slots: SocraticSlots
  passage: string
  humanChatLines: string[]
  recentPosts: string[]
  participantNames: string[]
  budgetMs?: number
}

export interface SocraticStageResult {
  message: string
  source: 'writer' | 'template'
}

type Outcome = { message: string } | { rejected: RejectedDraft }

async function draftOnce(input: SocraticStageInput, rejected: RejectedDraft[]): Promise<Outcome | 'writer-error'> {
  let draft: string
  try {
    draft = await writeSocraticQuestion(input.llm, {
      slots: input.slots,
      humanChatLines: input.humanChatLines,
      recentPosts: input.recentPosts,
      rejected
    })
  } catch (error) {
    logger.warn('[SocraticStage] writer call failed', error)
    return 'writer-error'
  }

  const shapeReasons = checkSocraticShape(draft, input)
  if (shapeReasons.length > 0) return { rejected: { draft, reasons: shapeReasons } }

  // Independent judges; either flagging (or erroring) rejects. Both fail closed internally.
  const [a, b] = await Promise.all([
    validateSocraticQuestion(input.llm, draft, input.passage),
    extractImpliedFindings(input.llm, draft, input.passage)
  ])
  if (!a.valid || !b.valid) return { rejected: { draft, reasons: [GENERIC_LEAK_REASON] } }
  return { message: draft }
}

/**
 * Produces the socratic_probe message: writer draft that passes every check, else a template from
 * the validated slots, else null (stay silent). Never re-runs the decision call.
 */
export default async function runSocraticStage(input: SocraticStageInput): Promise<SocraticStageResult | null> {
  const deadline = Date.now() + (input.budgetMs ?? SOCRATIC_STAGE_BUDGET_MS)
  let expired = false

  const attempts = async (): Promise<SocraticStageResult | null> => {
    const rejected: RejectedDraft[] = []
    for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS && !expired; attempt++) {
      const outcome = await draftOnce(input, rejected)
      if (expired) return null
      if (outcome === 'writer-error') {
        rejected.push({ draft: '(no draft)', reasons: ['write one question that follows every rule'] })
        continue
      }
      if ('message' in outcome) return { message: outcome.message, source: 'writer' }
      logger.info(`[SocraticStage] draft ${attempt} rejected: ${outcome.rejected.reasons.join('; ')}`)
      rejected.push(outcome.rejected)
    }
    return null
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()))
  })
  let result: SocraticStageResult | null | 'timeout'
  try {
    result = await Promise.race([attempts(), timeout])
  } finally {
    clearTimeout(timer)
  }
  if (result && result !== 'timeout') return result
  expired = true
  logger.info(
    `[SocraticStage] ${result === 'timeout' ? 'time budget exceeded' : 'no draft passed'} — using template fallback`
  )

  const template = renderSocraticTemplate(input.slots)
  const reasons = checkSocraticShape(template, input)
  if (reasons.length > 0) {
    logger.warn(`[SocraticStage] template fallback failed checks (${reasons.join('; ')}) — staying silent`)
    return null
  }
  logger.info('[SocraticStage] template fallback used')
  return { message: template, source: 'template' }
}
