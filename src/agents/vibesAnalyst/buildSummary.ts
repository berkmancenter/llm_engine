import conversationAnalyticsService from '../../services/conversationAnalytics.service.js'
import logger from '../../config/logger.js'
import curateVibesCard from './curate.js'
import verifyCuratedCard from './verifyCuration.js'
import annotateSpikes from './spikeAnnotation.js'
import annotateReceptions from './quoteReception.js'
import { loadReadableMessages } from './capabilities.js'
import { ConversationMetrics, CuratedVibesData } from '../../types/index.types.js'

/* How long the event ran, in whole minutes, for the card footer. Returns 0 when
   either timestamp is missing so the card still renders. */
function eventDurationMinutes(startTime?: Date, endTime?: Date): number {
  if (!startTime || !endTime) return 0
  const elapsedMs = endTime.getTime() - startTime.getTime()
  return Math.max(0, Math.round(elapsedMs / 60000))
}

/**
 * Builds the verified engagement card for one event. It computes the metrics, adds spike
 * and reception annotations from the channels the VA is allowed to read, then has the
 * curator write the card and the critic fact-check it.
 *
 * Shared by the event-stop auto path and the on-demand summon path so both produce an
 * identical card from one pipeline. The content annotations are best-effort: a failure
 * in either leaves the card with its numbers and still returns. This does NOT fetch
 * external tracked-session snapshots; that is an event-stop concern the caller handles.
 *
 * Returns the rendered card alongside the enriched metrics it was built from, so the
 * event-stop path can persist a metrics snapshot without recomputing. The metrics are the
 * post-enrichment bundle, so the reception count reflects the analyst's reading pass.
 */
export default async function buildVibesSummary(
  conversation,
  llm
): Promise<{ renderData: CuratedVibesData; metrics: ConversationMetrics }> {
  const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

  /* Read message text once, only from the channels the VA is allowed to (see
     loadReadableMessages). This is the one place the recap reads content, so the access
     boundary stays visible here. */
  let readableMessages
  try {
    readableMessages = await loadReadableMessages(conversation._id)
  } catch (error: unknown) {
    logger.error(
      `Vibes Analyst could not read messages for ${conversation._id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }

  if (readableMessages) {
    /* Label the busiest spikes with what was said then. Needs the event start to map a
       spike's minute window back to real times. */
    if (metrics.spikes.length > 0 && conversation.startTime) {
      try {
        metrics.spikes = await annotateSpikes(readableMessages, conversation.startTime, metrics.spikes, llm)
      } catch (error: unknown) {
        logger.error(
          `Vibes Analyst could not annotate spikes for ${conversation._id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    /* Surface speaker moments that drew a chat reaction, and how the room responded.
       Independent of spikes, so it runs whether or not chat volume ever surged. */
    try {
      metrics.receptions = await annotateReceptions(readableMessages, metrics.participation.posterCount, llm)
    } catch (error: unknown) {
      logger.error(
        `Vibes Analyst could not annotate receptions for ${conversation._id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  const eventMeta = {
    eventName: conversation.name,
    durationMinutes: eventDurationMinutes(conversation.startTime, conversation.endTime)
  }
  const draftCard = await curateVibesCard(metrics, eventMeta, llm)
  const renderData = await verifyCuratedCard(draftCard, metrics, llm)
  return { renderData, metrics }
}
