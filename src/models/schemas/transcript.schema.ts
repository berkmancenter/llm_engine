import mongoose from 'mongoose'
import { ITranscript } from '../../types/index.types.js'

const transcriptSchema = new mongoose.Schema<ITranscript>(
  {
    vectorStore: {
      embeddingsPlatform: {
        type: String
      },
      embeddingsModelName: {
        type: String
      }
    },
    status: {
      type: String,
      enum: ['active', 'paused', 'stopped'],
      default: 'stopped',
      required: true
    }
  },
  { _id: false }
)

export default transcriptSchema
