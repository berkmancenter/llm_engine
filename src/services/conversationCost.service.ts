import ConversationCost from '../models/conversationCost.model.js'
import { ConversationCostPhases } from '../types/index.types.js'

/* Upserts so a conversation stopped more than once (e.g. a manual re-stop) keeps a
   single cost document refreshed with the latest fetch, never duplicates. */
async function persistCost(conversation: { _id: unknown; name?: string }, phases: ConversationCostPhases) {
  return ConversationCost.findOneAndUpdate(
    { conversationId: conversation._id },
    { $set: { name: conversation.name, ...phases, source: 'langsmith', capturedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
}

export default { persistCost }
