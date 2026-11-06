import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import { IUnpackExplanation, UNPACK_EXPLANATION_STATUSES } from '../types/index.types.js'

export const unpackRangeSchema = new mongoose.Schema(
  {
    startMessageId: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message', required: true },
    startOffset: { type: Number, required: true },
    endMessageId: { type: mongoose.SchemaTypes.ObjectId, ref: 'Message', required: true },
    endOffset: { type: Number, required: true }
  },
  { _id: false }
)

const unpackExplanationSchema = new mongoose.Schema<IUnpackExplanation>(
  {
    conversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation', required: true, index: true },
    passageKey: { type: String, required: true, unique: true },
    range: { type: unpackRangeSchema },
    chunkIds: { type: [mongoose.SchemaTypes.ObjectId], ref: 'Message', default: [] },
    quote: { type: String, default: '' },
    passage: { start: Date, end: Date },
    status: { type: String, enum: UNPACK_EXPLANATION_STATUSES, required: true },
    generatingSince: { type: Date },
    whatTheyreSaying: { type: String },
    whyItMatters: { type: String },
    terms: { type: [{ term: String, text: String, _id: false }], default: undefined },
    headline: { type: String },
    visual: {
      type: new mongoose.Schema({ description: String, altText: String, caption: String }, { _id: false }),
      default: undefined
    }
  },
  { timestamps: true }
)

unpackExplanationSchema.plugin(toJSON)

const UnpackExplanation = mongoose.model<IUnpackExplanation>('UnpackExplanation', unpackExplanationSchema)
export default UnpackExplanation
