import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import { IUnpackRequest, UNPACK_DESTINATIONS, UNPACK_MODES } from '../types/index.types.js'

const unpackRequestSchema = new mongoose.Schema<IUnpackRequest>(
  {
    conversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation', required: true },
    user: { type: mongoose.SchemaTypes.ObjectId, ref: 'BaseUser', required: true },
    mode: { type: String, enum: UNPACK_MODES, required: true },
    destination: { type: String, enum: UNPACK_DESTINATIONS, default: 'privateChat' },
    chunkIds: { type: [mongoose.SchemaTypes.ObjectId], ref: 'Message', default: [] },
    quote: { type: String, default: '' },
    requestMessage: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message' },
    answerMessage: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message', required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

unpackRequestSchema.plugin(toJSON)

const UnpackRequest = mongoose.model<IUnpackRequest>('UnpackRequest', unpackRequestSchema)
export default UnpackRequest
