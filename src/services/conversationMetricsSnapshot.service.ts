import ConversationMetricsSnapshot from '../models/conversationMetricsSnapshot.model.js'
import { METRICS_VERSION } from './conversationAnalytics.service.js'
import { ConversationMetrics, ConversationMetricsSnapshotData } from '../types/index.types.js'

interface SnapshotOptions {
  /* Overrides the reception count. A live recap passes nothing, so the count is read from
     the enriched metrics (metrics.receptions.length). A scalar-only recompute (the backfill)
     never ran the reception pass, so it passes null to record "not computed" rather than a
     misleading 0. */
  receptionCount?: number | null
}

/* Reads the topic id off a conversation whether its topic is populated (a document with an
   _id, as the recap paths load it) or a raw ObjectId (as the backfill loads it). A raw
   ObjectId has no _id, so the optional chain falls through to the id itself. */
function topicIdOf(conversation): ConversationMetricsSnapshotData['topicId'] {
  return conversation.topic?._id ?? conversation.topic
}

/* Maps the in-memory metrics bundle to the scalar shape stored for trending. Every count is
   copied straight across; the verbatim quote text on spikes (annotation) and receptions
   (sparkQuote/reactionQuote) is dropped, kept only as a length. The tracked-session estimate
   is read from the primary source and is null when no analytics data exists, matching how the
   card itself treats a missing source. */
export function buildSnapshotPayload(
  conversation,
  metrics: ConversationMetrics,
  options: SnapshotOptions = {}
): ConversationMetricsSnapshotData {
  const primaryTracked = metrics.trackedSessionSources[0]
  const { audienceEngagement } = metrics
  const receptionCount = options.receptionCount !== undefined ? options.receptionCount : metrics.receptions.length

  return {
    conversationId: conversation._id,
    topicId: topicIdOf(conversation),
    name: conversation.name,
    endTime: conversation.endTime,
    platform: metrics.eventPlatform,
    metricsVersion: METRICS_VERSION,
    capturedAt: new Date(),

    posterCount: metrics.participation.posterCount,
    messageCount: metrics.participation.messageCount,
    frequentPosterCount: metrics.participation.frequentPosterCount,
    frequentPosterMessageShare: metrics.participation.frequentPosterMessageShare,

    trackedSessionStatus: metrics.trackedSessionStatus,
    trackedSessions: primaryTracked ? primaryTracked.trackedSessions : null,
    participantCount: audienceEngagement.participantCount,
    lurkerCount: audienceEngagement.lurkerCount,
    participationRate: audienceEngagement.participationRate,
    postersExceedTrackedSessions: audienceEngagement.postersExceedTrackedSessions,
    avgDwellSeconds: primaryTracked ? primaryTracked.avgDwellSeconds : null,
    totalActions: primaryTracked ? primaryTracked.totalActions : null,
    actionBreakdown: primaryTracked ? primaryTracked.actionBreakdown : {},
    actionUserBreakdown: primaryTracked ? primaryTracked.actionUserBreakdown : {},
    activeVisitorCount: primaryTracked ? primaryTracked.activeVisitorCount : null,

    channelSplit: { public: metrics.channelSplit.public, private: metrics.channelSplit.private },
    privateMessageCount: metrics.privateMessaging.privateMessageCount,
    distinctPrivateSenders: metrics.privateMessaging.distinctPrivateSenders,
    distinctPublicSenders: metrics.privateMessaging.distinctPublicSenders,
    botInvocationCount: metrics.botInvocations.count,
    resourceSummary: {
      total: metrics.resourceSummary.total,
      required: metrics.resourceSummary.required,
      referenced: metrics.resourceSummary.referenced,
      suggested: metrics.resourceSummary.suggested,
      withLinks: metrics.resourceSummary.withLinks
    },
    spikeCount: metrics.spikes.length,
    receptionCount,

    timeToFirstMessage: metrics.timeToFirstMessage,
    replyLatency: metrics.replyLatency,
    participationConcentration: metrics.participationConcentration,
    interactionStructure: metrics.interactionStructure
  }
}

/**
 * Persists one conversation's metrics snapshot for trending. Experimental conversations are
 * test runs, not real events, so they are skipped to keep the trend store clean (the baseline
 * already excludes them). The write upserts on (conversationId, metricsVersion), so a recap
 * that fires twice overwrites rather than duplicating, while a metrics-version bump writes a
 * fresh document and leaves the older definition's value intact. Returns the stored document,
 * or null when the conversation was skipped.
 */
export async function persistSnapshot(conversation, metrics: ConversationMetrics, options: SnapshotOptions = {}) {
  if (conversation.experimental === true) return null

  const payload = buildSnapshotPayload(conversation, metrics, options)
  return ConversationMetricsSnapshot.findOneAndUpdate(
    { conversationId: payload.conversationId, metricsVersion: payload.metricsVersion },
    payload,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
}

const conversationMetricsSnapshotService = {
  buildSnapshotPayload,
  persistSnapshot
}

export default conversationMetricsSnapshotService
