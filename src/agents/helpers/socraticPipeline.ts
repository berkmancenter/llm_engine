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

/** `stage`/`detail` are for server logs only; the writer only ever sees `rejected.reasons`. */
type Outcome = { message: string } | { rejected: RejectedDraft; stage: string; detail: string }

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
  if (shapeReasons.length > 0) {
    return { rejected: { draft, reasons: shapeReasons }, stage: 'shape', detail: shapeReasons.join('; ') }
  }

  // Independent judges; either flagging (or erroring) rejects. Both fail closed internally.
  const [a, b] = await Promise.all([
    validateSocraticQuestion(input.llm, draft, input.passage),
    extractImpliedFindings(input.llm, draft, input.passage)
  ])
  if (!a.valid || !b.valid) {
    const stages: string[] = []
    const details: string[] = []
    if (!a.valid) {
      stages.push('judge1:validateSocraticQuestion')
      details.push(`judge1: ${a.reason ?? ''}`)
    }
    if (!b.valid) {
      stages.push('judge2:extractImpliedFindings')
      details.push(`judge2: ${b.reason ?? ''}`)
    }
    return { rejected: { draft, reasons: [GENERIC_LEAK_REASON] }, stage: stages.join('+'), detail: details.join(' | ') }
  }
  return { message: draft }
}

/**
 * Produces the socratic_probe message: writer draft that passes every check, else a template from
 * the validated slots, else null (stay silent). Never re-runs the decision call.
 */
export default async function runSocraticStage(input: SocraticStageInput): Promise<SocraticStageResult | null> {
  const deadline = Date.now() + (input.budgetMs ?? SOCRATIC_STAGE_BUDGET_MS)
  let expired = false

  let attemptsUsed = 0

  const attempts = async (): Promise<SocraticStageResult | null> => {
    const rejected: RejectedDraft[] = []
    for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS && !expired; attempt++) {
      attemptsUsed = attempt
      const outcome = await draftOnce(input, rejected)
      if (expired) return null
      if (outcome === 'writer-error') {
        rejected.push({ draft: '(no draft)', reasons: ['write one question that follows every rule'] })
        continue
      }
      if ('message' in outcome) return { message: outcome.message, source: 'writer' }
      logger.info(
        `[SocraticStage] draft rejected ${JSON.stringify({
          attempt,
          stage: outcome.stage,
          reason: outcome.detail,
          draft: outcome.rejected.draft
        })}`
      )
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
  const logSummary = (outcome: 'posted-writer' | 'posted-template' | 'silent') =>
    logger.info(
      `[SocraticStage] summary ${JSON.stringify({ outcome, attempts: attemptsUsed, budgetHit: result === 'timeout' })}`
    )
  if (result && result !== 'timeout') {
    logSummary('posted-writer')
    return result
  }
  expired = true
  logger.info(
    `[SocraticStage] ${result === 'timeout' ? 'time budget exceeded' : 'no draft passed'} — using template fallback`
  )

  const template = renderSocraticTemplate(input.slots)
  const reasons = checkSocraticShape(template, input)
  if (reasons.length > 0) {
    logger.warn(`[SocraticStage] template fallback failed checks (${reasons.join('; ')}) — staying silent`)
    logSummary('silent')
    return null
  }
  logger.info('[SocraticStage] template fallback used')
  logSummary('posted-template')
  return { message: template, source: 'template' }
}
