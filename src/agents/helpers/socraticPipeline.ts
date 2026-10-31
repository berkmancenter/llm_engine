import logger from '../../config/logger.js'
import { checkSocraticShape, renderSocraticTemplate } from './socraticChecks.js'
import writeSocraticQuestion, { RejectedDraft } from './socraticQuestionWriter.js'
import { SocraticSlots } from './socraticSlots.js'

/** One initial draft plus three redrafts, each a writer-only call. */
export const MAX_WRITER_ATTEMPTS = 4

export interface SocraticStageInput {
  llm: unknown
  slots: SocraticSlots
  passage: string
  humanChatLines: string[]
  recentPosts: string[]
  participantNames: string[]
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

  return { message: draft }
}

/**
 * Produces the socratic_probe message: writer draft that passes every check, else a template from
 * the validated slots, else null (stay silent). Never re-runs the decision call.
 */
export default async function runSocraticStage(input: SocraticStageInput): Promise<SocraticStageResult | null> {
  const rejected: RejectedDraft[] = []
  let attemptsUsed = 0
  const logSummary = (outcome: 'posted-writer' | 'posted-template' | 'silent') =>
    logger.info(`[SocraticStage] summary ${JSON.stringify({ outcome, attempts: attemptsUsed })}`)

  for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt++) {
    attemptsUsed = attempt
    const outcome = await draftOnce(input, rejected)
    if (outcome === 'writer-error') {
      rejected.push({ draft: '(no draft)', reasons: ['write one question that follows every rule'] })
      continue
    }
    if ('message' in outcome) {
      logSummary('posted-writer')
      return { message: outcome.message, source: 'writer' }
    }
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
  logger.info('[SocraticStage] no draft passed — using template fallback')

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
