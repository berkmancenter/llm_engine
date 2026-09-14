import ConversationCost from '../models/conversationCost.model.js'
import { ConversationCostAggregates, ConversationCostPhases } from '../types/index.types.js'

export interface ConversationCostBaseline {
  phases: ConversationCostPhases
  /* Absent on a record written before capture times were tracked. A caller must then treat
     the baseline as unusable for accumulation (see accumulateCostPhases): with no point to
     window a new read from, the read covers everything still retained, which already
     includes whatever the baseline counted. */
  capturedAt?: Date
}

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

/* The running total a new windowed read is added onto, and the point to window it from.
   conversationId is uniquely indexed, so there is at most one record per conversation.
   Read once at the top of a flow and held in memory: createPending may insert between the
   read and the final write, and re-reading would then fold that partial figure back in. */
async function findBaseline(conversationId: unknown): Promise<ConversationCostBaseline | null> {
  const record = await ConversationCost.findOne({ conversationId }).select('liveEvent postEvent capturedAt').lean()
  if (!record) return null
  return {
    phases: { liveEvent: record.liveEvent, postEvent: record.postEvent },
    capturedAt: record.capturedAt
  }
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

/* Nightly proactive check on a conversation that's still active (see Number Cruncher's
   respond(), the nightly cron sweep) — a live, non-final read on today's running total.
   Same $set-upsert shape as persistCost, but deliberately keeps status 'pending': the
   conversation hasn't stopped, so this can never be the settled figure persistCost's
   'complete' means. Each night's snapshot overwrites the last; no history of past
   nightly snapshots is kept, only the most recent one.

   Accepted gap: the nightly sweep only selects conversations still `active`, so this
   should never race persistCost in practice — but if a conversation stops (persistCost
   writes 'complete') at the exact moment its snapshot from this same tick is still in
   flight, this can overwrite that 'complete' record back to 'pending'. Not guarded
   against: no natural id ties a snapshot to "the sweep that started before the stop",
   and the record still self-corrects next time anything calls persistCost. */
async function persistSnapshot(
  conversation: { _id: unknown; name?: string },
  phases: ConversationCostPhases,
  opts: { topicIsPrivate: boolean; capturedAt?: Date }
) {
  return ConversationCost.findOneAndUpdate(
    { conversationId: conversation._id },
    {
      $set: {
        name: conversation.name,
        ...phases,
        source: 'langsmith',
        status: 'pending',
        topicIsPrivate: opts.topicIsPrivate,
        /* The caller passes the moment the LangSmith read STARTED, not the moment this
           write happens, because this value becomes the next read's window start. Stamping
           write-time instead would silently drop anything logged while the read was in
           flight: too late for this window, before the next one begins. */
        capturedAt: opts.capturedAt ?? new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
}

export default { createPending, persistCost, persistSnapshot, findBaseline }
