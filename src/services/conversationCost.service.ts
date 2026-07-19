import ConversationCost from '../models/conversationCost.model.js'
import { ConversationCostAggregates, ConversationCostPhases } from '../types/index.types.js'

const ZERO_AGGREGATE: ConversationCostAggregates = {
  estimatedCostUSD: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  llmCallCount: 0,
  models: [],
  agents: [],
  hasUnpricedCalls: false
}

export const ZERO_PHASES: ConversationCostPhases = {
  liveEvent: ZERO_AGGREGATE,
  postEvent: ZERO_AGGREGATE
}

/* Written the moment a conversationStopped event is picked up, before the settle-poll
   confirms a final number — carries whatever a single immediate LangSmith read found
   (pass ZERO_PHASES when nothing has landed yet), so a crash or a very slow poll never
   leaves zero record of an event that happened. $setOnInsert only: if a record already
   exists (e.g. a rapid re-stop), this deliberately leaves its last known status/figures
   alone rather than resetting them to pending — persistCost always overwrites it with
   fresh data once the poll resolves regardless. */
async function createPending(
  conversation: { _id: unknown; name?: string },
  phases: ConversationCostPhases,
  opts: { topicIsPrivate: boolean }
) {
  return ConversationCost.findOneAndUpdate(
    { conversationId: conversation._id },
    {
      $setOnInsert: {
        conversationId: conversation._id,
        name: conversation.name,
        liveEvent: phases.liveEvent,
        postEvent: phases.postEvent,
        source: 'langsmith',
        status: 'pending',
        topicIsPrivate: opts.topicIsPrivate,
        capturedAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
}

/* Upserts so a conversation stopped more than once (e.g. a manual re-stop) keeps a
   single cost document refreshed with the latest fetch, never duplicates. Always
   marks status 'complete' — even when phases came back all-zero, so a record never
   stays stuck showing 'pending' once the settle-poll has actually finished. */
async function persistCost(
  conversation: { _id: unknown; name?: string },
  phases: ConversationCostPhases,
  opts: { topicIsPrivate: boolean }
) {
  return ConversationCost.findOneAndUpdate(
    { conversationId: conversation._id },
    {
      $set: {
        name: conversation.name,
        ...phases,
        source: 'langsmith',
        status: 'complete',
        topicIsPrivate: opts.topicIsPrivate,
        capturedAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
}

export default { createPending, persistCost }
