import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'

/* One per-event snapshot of the Vibes Analyst metrics, one document per event in its own
   collection (kept separate from the Conversation doc so the metrics can be queried as a
   time series). It is written when an event's recap is built, so every metric trends over
   time instead of being recomputed from raw messages on each recap.

   It stores scalar aggregates only. The verbatim quote text that spikes and receptions
   carry (spike.annotation, reception.sparkQuote/reactionQuote) is deliberately left out:
   this is a long-lived analytics store and those quotes are word-for-word chat and
   backchannel content. Counts are kept; the words are not, so the privacy posture matches
   the conversationAnalytics snapshot, which also holds counts only.

   metricsVersion records the metric definitions in force when the snapshot was taken. A
   trend that crosses a definition change would otherwise read as a continuous line, so the
   baseline compares only snapshots that share a version (see METRICS_VERSION in
   conversationAnalytics.service). The estimate fields (everything sourced from web
   analytics) are captured "as of" capturedAt and are never revised when late provider data
   arrives. */
const eventMetricsSnapshotSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    /* The recurring space the event lives under. Indexed because the baseline and history
       both query by topic to find an event's recent neighbours. */
    topicId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Topic',
      required: true,
      index: true
    },
    eventName: {
      type: String
    },
    /* The event-end timestamp, the time axis a trend is plotted against and the sort key for
       "recent past events". */
    eventEndTime: {
      type: Date,
      required: true,
      index: true
    },
    eventPlatform: {
      type: String,
      enum: ['nextspace', 'zoom', 'both'],
      default: 'nextspace'
    },
    metricsVersion: {
      type: Number,
      required: true,
      index: true
    },
    capturedAt: {
      type: Date,
      default: Date.now
    },

    // Participation (exact).
    posterCount: { type: Number, default: 0 },
    messageCount: { type: Number, default: 0 },
    frequentPosterCount: { type: Number, default: 0 },
    frequentPosterMessageShare: { type: Number, default: null },

    // Audience engagement (estimate, as of capturedAt). null where no tracked-session data
    // exists, or where a count could not be reconciled against the poster count.
    trackedSessionStatus: {
      type: String,
      enum: ['available', 'notTracked', 'unavailable'],
      default: 'notTracked'
    },
    trackedSessions: { type: Number, default: 0 },
    participantCount: { type: Number, default: null },
    lurkerCount: { type: Number, default: null },
    participationRate: { type: Number, default: null },
    postersExceedTrackedSessions: { type: Boolean, default: null },
    avgDwellSeconds: { type: Number, default: null },
    totalActions: { type: Number, default: null },

    // Feature usage (estimate, as of capturedAt): allowlisted page actions off the primary
    // tracked source. actionBreakdown is occurrence counts, actionUserBreakdown is distinct
    // visitors per action; activeVisitorCount is the distinct-active-visitor denominator. Mixed
    // for the same reason as deviceBreakdown: the key set varies and we store counts only.
    actionBreakdown: {
      type: mongoose.SchemaTypes.Mixed,
      default: {}
    },
    actionUserBreakdown: {
      type: mongoose.SchemaTypes.Mixed,
      default: {}
    },
    activeVisitorCount: { type: Number, default: 0 },

    // Channel split (exact): people's messages, public chat vs private one-to-one with the bot.
    channelSplit: {
      public: { type: Number, default: 0 },
      private: { type: Number, default: 0 }
    },

    // Private messaging (exact): the private message count plus distinct senders in each
    // channel kind, so the share-of-posters comparison can be trended over time.
    privateMessageCount: { type: Number, default: 0 },
    distinctPrivateSenders: { type: Number, default: 0 },
    distinctPublicSenders: { type: Number, default: 0 },

    // Bot invocations (exact): how many times participants called on the assistant by name.
    botInvocationCount: { type: Number, default: 0 },

    // Resource counts (exact), from participant-visible resources only.
    resourceSummary: {
      total: { type: Number, default: 0 },
      required: { type: Number, default: 0 },
      referenced: { type: Number, default: 0 },
      suggested: { type: Number, default: 0 },
      withLinks: { type: Number, default: 0 }
    },

    // How many windows stood out as spikes; the quote/topic annotation is not stored.
    spikeCount: { type: Number, default: 0 },

    // How many speaker moments drew a chat reaction; quotes are not stored. null when the
    // reception pass did not run (a backfill recomputes scalars only, so it cannot know this).
    receptionCount: { type: Number, default: null }
  },
  {
    timestamps: true
  }
)

eventMetricsSnapshotSchema.plugin(toJSON)
eventMetricsSnapshotSchema.plugin(paginate)

/* One snapshot per event per metrics version. Re-running an event's recap overwrites its
   snapshot for the same version rather than duplicating it (the service upserts on this
   key); a version bump writes a fresh document so the old definition's value is preserved. */
eventMetricsSnapshotSchema.index({ conversationId: 1, metricsVersion: 1 }, { unique: true })

/**
 * @typedef EventMetricsSnapshot
 */
const EventMetricsSnapshot = mongoose.model('EventMetricsSnapshot', eventMetricsSnapshotSchema)

export default EventMetricsSnapshot
