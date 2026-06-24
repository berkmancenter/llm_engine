import ConversationAnalytics from '../../models/conversationAnalytics.model.js'
import logger from '../../config/logger.js'
import fetchMatomoSnapshot from './matomo.js'
import { AnalyticsSnapshot } from '../../types/index.types.js'

type AnalyticsSourceFetcher = (conversation) => Promise<AnalyticsSnapshot | null>

/* Every external tracked-session source we can pull, keyed by the name stored on
   the ConversationAnalytics document and in a conversation's analyticsRefs. To add
   a source, write its fetcher and add one entry here; the read path and the recap
   card do not change. Mongo participation data is first-party and is not a source
   here; it is always computed separately. */
const analyticsSources: Record<string, AnalyticsSourceFetcher> = {
  matomo: fetchMatomoSnapshot
}

/**
 * Pulls a fresh snapshot from every configured analytics source for one event and
 * stores one document per source. Each fetcher self-checks and returns null when
 * its config or the event's reference is missing, in which case that source is
 * skipped. Re-running overwrites a source's existing snapshot rather than adding a
 * duplicate, since the document is keyed by conversation and source.
 */
export async function fetchAndStoreSnapshot(conversation): Promise<void> {
  for (const [source, fetchSnapshot] of Object.entries(analyticsSources)) {
    const snapshot = await fetchSnapshot(conversation)
    if (!snapshot) continue

    await ConversationAnalytics.findOneAndUpdate(
      { conversationId: conversation._id, source },
      { ...snapshot, source, conversationId: conversation._id, capturedAt: new Date() },
      { upsert: true, setDefaultsOnInsert: true }
    )
    logger.info(`Stored ${source} analytics snapshot for conversation ${conversation._id}`)
  }
}

export default { fetchAndStoreSnapshot }
