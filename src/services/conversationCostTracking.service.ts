import logger from '../config/logger.js'
import conversationCostService, { ZERO_PHASES } from './conversationCost.service.js'
import {
  fetchConversationCost,
  fetchConversationCostWithSettle,
  combineCostAggregates,
  isLangsmithCostTrackingConfigured
} from '../agents/numberCruncher/conversationCost.js'
import { ConversationCostAggregates, ConversationCostPhases } from '../types/index.types.js'

export interface ConversationCostTrackingResult {
  phases: ConversationCostPhases
  total: ConversationCostAggregates
}

/* Shared by the preliminary read and the settled read: combine the two phases into
   one headline total (or null when there's nothing to combine yet) and, when it
   found any LLM calls, log it the same way both times. The "nothing found" case
   (null, or a real total with zero calls) is left to each call site, since what
   happens next differs (record as pending vs. finalize as zero). */
function summarizeCost(
  conversationId: string,
  phases: ConversationCostPhases | null,
  label: string
): ConversationCostAggregates | null {
  const total = phases ? combineCostAggregates(phases.liveEvent, phases.postEvent) : null
  if (total && total.llmCallCount > 0) {
    logger.debug(
      `conversationCost: ${label} for conversation ${conversationId} — ` +
        `${total.llmCallCount} LLM calls, ~$${total.estimatedCostUSD.toFixed(2)}`
    )
  }
  return total
}

/**
 * Core cost-tracking flow for a stopped conversation, agent-agnostic so it can run
 * whether or not any Slack-facing agent (e.g. Number Cruncher) is provisioned:
 *
 * 1. Computes a preliminary estimate immediately from whatever LangSmith has
 *    ingested so far, and persists it as a `pending` record — a real early number
 *    rather than a zeroed placeholder, so a crash or a very slow settle-poll still
 *    leaves the best estimate available at the time.
 * 2. Settles to a final number over the poll window (see fetchConversationCostWithSettle)
 *    and persists it as `complete`.
 *
 * Returns null when LangSmith tracing isn't configured, or when no cost data ever
 * settled (the record is still finalized at zero in that case).
 */
export async function trackConversationCost(
  conversation: { _id: unknown; name?: string },
  opts: { topicIsPrivate: boolean }
): Promise<ConversationCostTrackingResult | null> {
  const conversationId = String(conversation._id)

  if (!isLangsmithCostTrackingConfigured()) {
    logger.debug(
      `conversationCost: LangSmith tracing is not enabled (need LANGSMITH_TRACING_V2, ` +
        `LANGSMITH_API_KEY, and LANGSMITH_PROJECT); skipping cost tracking for conversation ${conversationId}`
    )
    return null
  }

  logger.debug(`conversationCost: conversation ${conversationId} stopped; computing preliminary cost`)
  const preliminaryPhases = await fetchConversationCost(conversationId)
  const preliminaryTotal = summarizeCost(conversationId, preliminaryPhases, 'preliminary cost')
  if (!preliminaryTotal || preliminaryTotal.llmCallCount === 0) {
    logger.debug(
      `conversationCost: no LangSmith cost data available yet for conversation ${conversationId}; ` +
        'recording pending record with zero values'
    )
  }

  try {
    await conversationCostService.createPending(conversation, preliminaryPhases ?? ZERO_PHASES, opts)
    logger.debug(`conversationCost: pending cost record created for conversation ${conversationId}`)
  } catch (error) {
    logger.error(`conversationCost: could not create pending cost record for ${conversationId}`, error)
  }

  logger.debug(`conversationCost: starting LangSmith cost settle-poll for conversation ${conversationId}`)
  const phases = await fetchConversationCostWithSettle(conversationId)
  const total = summarizeCost(conversationId, phases, 'settled cost')

  if (!total || total.llmCallCount === 0) {
    logger.debug(
      `conversationCost: no LangSmith cost data settled for conversation ${conversationId}; ` +
        'finalizing record with zero cost'
    )
    try {
      await conversationCostService.persistCost(conversation, phases ?? ZERO_PHASES, opts)
    } catch (error) {
      logger.error(`conversationCost: could not finalize cost record for ${conversationId}`, error)
    }
    return null
  }

  try {
    await conversationCostService.persistCost(conversation, phases!, opts)
  } catch (error) {
    logger.error(`conversationCost: could not persist cost record for ${conversationId}`, error)
  }

  return { phases: phases!, total }
}

export default { trackConversationCost }
