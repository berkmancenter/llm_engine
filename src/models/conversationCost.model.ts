import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'
import { ConversationCostRecord } from '../types/index.types.js'

/* One persisted LLM-cost estimate per conversation. Kept in its own collection — NOT
   on ConversationAnalytics, which holds engagement metrics sourced from web
   analytics — because cost has a different
   source (LangSmith), lifecycle, and audience. Figures use LangSmith's pricing
   table, not the provider invoice, so they are estimates and are never reconciled
   against billing after capture.

   liveEvent and postEvent are stored as separate sub-documents (not pre-summed) so
   spend while the conversation was running can be disaggregated from spend on
   after-the-fact work (the Vibes Analyst recap, the conversation summary) without
   re-deriving it from LangSmith.

   THIS RECORD IS AN ACCUMULATOR, NOT A CACHE OF A LANGSMITH QUERY. LangSmith drops
   runs past a retention horizon, so no single read can reproduce the lifetime cost of
   a conversation older than that — an unbounded read returns a trailing window, and it
   SHRINKS as runs age out. How long that horizon is does not matter to anything here,
   and deliberately isn't encoded: it's a per-project setting (base vs. extended
   retention, currently 14 vs. 400 days) rather than a property of the plan, an ops
   change away from moving, and every always-on conversation crosses it eventually at
   either length. Every writer therefore
   reads only what is new since `capturedAt` and adds it to what is already stored,
   so each run is counted exactly once, while it is still visible. See
   fetchConversationCost's `since` and accumulateCostPhases.

   Two invariants fall out of that, and anything writing here must preserve both:

   - `capturedAt` is the next read's window start, so it must advance on EVERY
     capture, including one that found nothing. Leaving it put lets the window grow
     until it reaches past the retention horizon and starts missing runs outright.
   - A write must never replace the stored figures with the result of an unbounded
     read. That is the one thing guaranteed to lose history, silently, and only for
     the longest-running conversations. */
const modelBreakdownSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    llmCalls: { type: Number, required: true },
    promptTokens: { type: Number, required: true },
    completionTokens: { type: Number, required: true },
    estimatedCostUSD: { type: Number, required: true },
    // False when LangSmith had no pricing-table entry for at least one call to this
    // model (e.g. a self-hosted vLLM/Ollama model) — see conversationCost.ts.
    priced: { type: Boolean, required: true }
  },
  { _id: false }
)

const agentBreakdownSchema = new mongoose.Schema(
  {
    agentType: { type: String, required: true },
    llmCalls: { type: Number, required: true },
    estimatedCostUSD: { type: Number, required: true }
  },
  { _id: false }
)

const costAggregateSchema = new mongoose.Schema(
  {
    estimatedCostUSD: { type: Number, required: true },
    totalPromptTokens: { type: Number, required: true },
    totalCompletionTokens: { type: Number, required: true },
    llmCallCount: { type: Number, required: true },
    models: { type: [modelBreakdownSchema], default: [] },
    agents: { type: [agentBreakdownSchema], default: [] },
    hasUnpricedCalls: { type: Boolean, required: true }
  },
  { _id: false }
)

const conversationCostSchema = new mongoose.Schema<ConversationCostRecord>(
  {
    conversationId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      unique: true,
      index: true
    },
    name: { type: String },
    liveEvent: { type: costAggregateSchema, required: true },
    postEvent: { type: costAggregateSchema, required: true },
    source: { type: String, required: true, default: 'langsmith' },
    capturedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'complete'], required: true, default: 'pending' },
    topicIsPrivate: { type: Boolean, required: true, default: false }
  },
  { timestamps: true }
)

conversationCostSchema.plugin(toJSON)
conversationCostSchema.plugin(paginate)

const ConversationCost = mongoose.model<ConversationCostRecord>('ConversationCost', conversationCostSchema)
export default ConversationCost
