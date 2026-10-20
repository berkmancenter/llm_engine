import mongoose, { HydratedDocument, Model } from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'
import { PaginateResults } from '../types/index.types.js'

/** Reasons an admin can give when hiding. Unhide also accepts short free text (see the validation). */
export const MODERATION_REASONS = ['pii', 'harassment', 'off-topic', 'other'] as const
export const MODERATION_REASON_MAX_LENGTH = 200

export interface IModerationEvent {
  _id?: mongoose.Types.ObjectId
  conversation: mongoose.Types.ObjectId
  actor: mongoose.Types.ObjectId
  action: 'hide' | 'unhide'
  scope: 'message' | 'user'
  targetMessage?: mongoose.Types.ObjectId
  targetUser?: mongoose.Types.ObjectId
  messageIds: mongoose.Types.ObjectId[]
  reason?: string
  createdAt?: Date
}

interface ModerationEventStatics {
  paginate(filter: unknown, options: unknown): Promise<PaginateResults<HydratedDocument<IModerationEvent>>>
}
type ModerationEventModel = Model<IModerationEvent, Record<string, never>> & ModerationEventStatics

/**
 * Append-only record of admin hide/unhide actions, one per call that changed state. It stores ids and
 * a reason, never message bodies. Nothing in the API edits or deletes an event, and the schema refuses
 * both as well, so a code path added later cannot quietly rewrite the history.
 */
const moderationEventSchema = new mongoose.Schema<IModerationEvent, ModerationEventModel>(
  {
    conversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation', required: true },
    actor: { type: mongoose.SchemaTypes.ObjectId, ref: 'BaseUser', required: true },
    action: { type: String, enum: ['hide', 'unhide'], required: true },
    scope: { type: String, enum: ['message', 'user'], required: true },
    targetMessage: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message' },
    targetUser: { type: mongoose.SchemaTypes.ObjectId, ref: 'BaseUser' },
    // the ids whose hidden state actually changed, as the REST call returned them
    messageIds: { type: [mongoose.SchemaTypes.ObjectId], default: [] },
    reason: { type: String, maxlength: MODERATION_REASON_MAX_LENGTH }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

const appendOnly = () => {
  throw new Error('ModerationEvent is append-only')
}
moderationEventSchema.pre('save', function () {
  if (!this.isNew) appendOnly()
})
;(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete'
  ] as const
).forEach((op) => moderationEventSchema.pre(op, appendOnly))
moderationEventSchema.pre('deleteOne', { document: true, query: false }, appendOnly)

moderationEventSchema.plugin(toJSON)
moderationEventSchema.plugin(paginate)
// the log is read per conversation, newest first
moderationEventSchema.index({ conversation: 1, createdAt: 1 })

const ModerationEvent = mongoose.model<IModerationEvent, ModerationEventModel>('ModerationEvent', moderationEventSchema)
export default ModerationEvent
