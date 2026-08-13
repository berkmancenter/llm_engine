import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'

const evaluatorScoreSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    mean: { type: Number, required: true },
    min: { type: Number, required: true },
    count: { type: Number, required: true },
    lowScoreCount: { type: Number, required: true }
  },
  { _id: false }
)

const qualityReportSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    conversationName: { type: String },
    reportDate: { type: Date, required: true },
    evaluators: { type: [evaluatorScoreSchema], default: [] },
    overallMean: { type: Number, required: true },
    tracesScored: { type: Number, required: true },
    totalLowScoreCount: { type: Number, required: true }
  },
  { timestamps: true }
)

qualityReportSchema.index({ conversationId: 1, reportDate: 1 }, { unique: true })
qualityReportSchema.plugin(toJSON)
qualityReportSchema.plugin(paginate)

const QualityReport = mongoose.model('QualityReport', qualityReportSchema)
export default QualityReport
