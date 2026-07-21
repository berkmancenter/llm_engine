import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'
import { ConversationCostRecord } from '../types/index.types.js'

/* One persisted LLM-cost estimate per conversation, captured after the conversation
   stops. Kept in its own collection — NOT on ConversationAnalytics, which holds
   engagement metrics sourced from web analytics — because cost has a different
   source (LangSmith), lifecycle, and audience. Figures use LangSmith's pricing
   table, not the provider invoice, so they are estimates and are never reconciled
   against billing after capture.

   liveEvent and postEvent are stored as separate sub-documents (not pre-summed) so
   spend while the conversation was running can be disaggregated from spend on
   after-the-fact work (the Vibes Analyst recap, the conversation summary) without
   re-deriving it from LangSmith, whose own retention is only ~2 weeks. */
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
