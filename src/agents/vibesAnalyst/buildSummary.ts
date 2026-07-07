import conversationAnalyticsService from '../../services/conversationAnalytics.service.js'
import logger from '../../config/logger.js'
import curateVibesCard from './curate.js'
import verifyCuratedCard from './verifyCuration.js'
import annotateSpikes from './spikeAnnotation.js'
import annotateReceptions from './quoteReception.js'
import { loadReadableMessages } from './capabilities.js'
import { ConversationMetrics, CuratedVibesData } from '../../types/index.types.js'

/* Pulls a log-friendly message off an unknown thrown value. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
 * The spike and reception annotations are mechanical extraction passes (pull a topic, a
 * quote, a sentiment from message text), so they run on fastLlm, a faster model, and run
 * concurrently since neither reads the other's output. The card writing and fact-check
 * stay on llm, the main model, since they carry the judgment. fastLlm defaults to llm so a
 * caller that has only one model still works.
 *
 * Returns the rendered card alongside the enriched metrics it was built from, so the
 * event-stop path can persist a metrics snapshot without recomputing. The metrics are the
 * post-enrichment bundle, so the reception count reflects the analyst's reading pass.
 */
export default async function buildVibesSummary(
  conversation,
  llm,
  fastLlm = llm
): Promise<{ renderData: CuratedVibesData; metrics: ConversationMetrics }> {
  const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

  /* Read message text once, only from the channels the VA is allowed to (see
     loadReadableMessages). This is the one place the recap reads content, so the access
     boundary stays visible here. */
  let readableMessages
  try {
    readableMessages = await loadReadableMessages(conversation._id)
  } catch (error: unknown) {
    logger.error(`Vibes Analyst could not read messages for ${conversation._id}: ${errorText(error)}`)
  }

  if (readableMessages) {
    const messages = readableMessages
    /* Both annotation passes read the same messages and write different metric fields, so run
       them at once on the faster model. Each is best-effort: a failure logs and leaves that
       field as computeConversationMetrics left it, so one failing never blocks the other or
       the card. Spike labelling needs the event start to map a spike's minute window back to
       real times, and only runs when there were spikes to label. */
    const [annotatedSpikes, annotatedReceptions] = await Promise.all([
      metrics.spikes.length > 0 && conversation.startTime
        ? annotateSpikes(messages, conversation.startTime, metrics.spikes, fastLlm).catch((error: unknown) => {
            logger.error(`Vibes Analyst could not annotate spikes for ${conversation._id}: ${errorText(error)}`)
            return metrics.spikes
          })
        : Promise.resolve(metrics.spikes),
      annotateReceptions(messages, metrics.participation.posterCount, fastLlm).catch((error: unknown) => {
        logger.error(`Vibes Analyst could not annotate receptions for ${conversation._id}: ${errorText(error)}`)
        return metrics.receptions
      })
    ])
    metrics.spikes = annotatedSpikes
    metrics.receptions = annotatedReceptions
  }

  const eventMeta = {
    eventName: conversation.name,
    durationMinutes: eventDurationMinutes(conversation.startTime, conversation.endTime)
  }
  const draftCard = await curateVibesCard(metrics, eventMeta, llm)
  const renderData = await verifyCuratedCard(draftCard, metrics, llm)
  return { renderData, metrics }
}
