import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import { IUnpackGroupPost, UNPACK_GROUP_POST_STATUSES } from '../types/index.types.js'

const unpackGroupPostSchema = new mongoose.Schema<IUnpackGroupPost>(
  {
    conversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation', required: true, index: true },
    chunkIds: { type: [mongoose.SchemaTypes.ObjectId], ref: 'Message', required: true },
    message: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message', required: true },
    status: { type: String, enum: UNPACK_GROUP_POST_STATUSES, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// On a list field, a unique index refuses any second row sharing even one chunk ID, so a passage is posted once
unpackGroupPostSchema.index({ chunkIds: 1 }, { unique: true })

unpackGroupPostSchema.plugin(toJSON)

const UnpackGroupPost = mongoose.model<IUnpackGroupPost>('UnpackGroupPost', unpackGroupPostSchema)
export default UnpackGroupPost
