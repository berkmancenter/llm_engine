import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

/* Conversation.summary/summaryProvenance moved under Conversation.postEventAnalysis (see
   PostEventAnalysis in src/types/index.types.ts) so a future postEvent extraction is one more
   key there instead of another top-level field on Conversation - openThreads is the first to
   follow that shape, and never existed as a top-level field, so there is nothing of its to
   migrate here.

   Only documents that ever got a real summary are moved: `summary` defaulted to '' under the
   old schema, so most conversations carry nothing worth nesting - those just have the two old
   field names unset instead. This is a pure field rename; no content changes. */

const conversations = (db: MigrationContext['db']) => db.collection('conversations')

export const up: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const moved = await conversations(db).updateMany(
    { $or: [{ summary: { $exists: true, $ne: '' } }, { summaryProvenance: { $exists: true } }] },
    { $rename: { summary: 'postEventAnalysis.summary', summaryProvenance: 'postEventAnalysis.summaryProvenance' } }
  )

  const cleaned = await conversations(db).updateMany(
    { $or: [{ summary: { $exists: true } }, { summaryProvenance: { $exists: true } }] },
    { $unset: { summary: '', summaryProvenance: '' } }
  )

  return { moved: moved.modifiedCount, cleaned: cleaned.modifiedCount }
}

/* Best-effort revert, same caveat as 20260824000000-rename-legacy-agent-job-names's down:
   exact only for documents this migration's `up` actually moved. A conversation stopped under
   the new shape in between (summary or openThreads written directly to postEventAnalysis)
   keeps whatever else is on postEventAnalysis - only the two renamed keys move back. */
export const down: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const result = await conversations(db).updateMany(
    { 'postEventAnalysis.summary': { $exists: true } },
    { $rename: { 'postEventAnalysis.summary': 'summary', 'postEventAnalysis.summaryProvenance': 'summaryProvenance' } }
  )
  return result.modifiedCount
}

export default {
  name: '20261118000000-nest-conversation-summary',
  up,
  down
}
