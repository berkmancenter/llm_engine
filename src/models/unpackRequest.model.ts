import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import { IUnpackRequest, UNPACK_DESTINATIONS, UNPACK_MODES, UNPACK_REQUEST_STATUSES } from '../types/index.types.js'
import { unpackRangeSchema } from './unpackPassageExplanation.model.js'

const unpackRequestSchema = new mongoose.Schema<IUnpackRequest>(
  {
    conversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation', required: true },
    user: { type: mongoose.SchemaTypes.ObjectId, ref: 'BaseUser', required: true },
    mode: { type: String, enum: UNPACK_MODES, required: true },
    status: { type: String, enum: UNPACK_REQUEST_STATUSES, required: true },
    destination: { type: String, enum: UNPACK_DESTINATIONS },
    chunkIds: { type: [mongoose.SchemaTypes.ObjectId], ref: 'Message', default: [] },
    quote: { type: String, default: '' },
    passageKey: { type: String },
    explanation: { type: mongoose.SchemaTypes.ObjectId, ref: 'UnpackPassageExplanation' },
    range: { type: unpackRangeSchema },
    requestMessage: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message' },
    answerMessage: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message' }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// Finds earlier sent asks about the same chunks
unpackRequestSchema.index({ conversation: 1, chunkIds: 1 })
// Finds everyone waiting on a passage's explanation when it is written or fails
unpackRequestSchema.index({ passageKey: 1 })
// Partial, because "Catch me up" asks have no passage and one person can make many of them
unpackRequestSchema.index(
  { user: 1, passageKey: 1 },
  { unique: true, partialFilterExpression: { passageKey: { $type: 'string' } } }
)

unpackRequestSchema.plugin(toJSON)

const UnpackRequest = mongoose.model<IUnpackRequest>('UnpackRequest', unpackRequestSchema)
export default UnpackRequest
