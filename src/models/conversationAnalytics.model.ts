import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'

/* One aggregate snapshot document per conversation, sourced from an external
   analytics provider (e.g. Matomo). Holds counts and sums only, never pseudonyms
   or per-attendee identity, so web analytics can be cached in llm_engine without
   importing identifiable data. Every ratio (avg dwell, participation rate) is
   derived at read time from these additive facts, never stored. The
   collection is the contract: the vibes analyst reads it, and whoever writes it
   (frontend push or a backend analytics client) is decided later without touching
   the read path. */
const conversationAnalyticsSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    attendeeCount: {
      type: Number,
      default: 0
    },
    totalVisits: {
      type: Number,
      default: 0
    },
    totalActions: {
      type: Number,
      default: 0
    },
    totalDwellSeconds: {
      type: Number,
      default: 0
    },
    // A label-to-count map (e.g. { desktop, mobile, tablet }). Mixed because
    // Matomo's device segments vary and we only ever store counts.
    deviceBreakdown: {
      type: mongoose.SchemaTypes.Mixed,
      default: {}
    },
    source: {
      type: String,
      default: 'matomo'
    },
    capturedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
)

conversationAnalyticsSchema.plugin(toJSON)
conversationAnalyticsSchema.plugin(paginate)

/* One snapshot per conversation per analytics source. A conversation can hold a
   snapshot from each source (e.g. Matomo plus another), but re-capturing the same
   source overwrites rather than duplicates. */
conversationAnalyticsSchema.index({ conversationId: 1, source: 1 }, { unique: true })

/**
 * @typedef ConversationAnalytics
 */
const ConversationAnalytics = mongoose.model('ConversationAnalytics', conversationAnalyticsSchema)

export default ConversationAnalytics
