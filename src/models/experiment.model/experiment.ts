import mongoose from 'mongoose'

import { toJSON, paginate } from '../plugins/index.js'
import { IExperiment } from '../../types/index.types.js'
import agentModificationsSchema from './agentModifications.schema.js'

const experimentSchema = new mongoose.Schema<IExperiment>(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      trim: true
    },
    status: {
      type: String,
      enum: ['running', 'completed', 'failed', 'not started'],
      required: true,
      default: 'not started'
    },
    agentModifications: {
      type: [agentModificationsSchema],
      default: undefined
    },
    executedAt: {
      type: Date
    },

    baseConversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation', required: true },
    resultConversation: { type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation' },
    createdBy: { type: mongoose.SchemaTypes.ObjectId, ref: 'User', required: true }
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        // Only include conversation IDs, not the full object to prevent circular refs
        if (ret.baseConversation) {
          // eslint-disable-next-line no-param-reassign, @typescript-eslint/no-explicit-any
          ret.baseConversation = ret.baseConversation._id || (ret.baseConversation as any).id
        }
        if (ret.resultConversation) {
          // eslint-disable-next-line no-param-reassign, @typescript-eslint/no-explicit-any
          ret.resultConversation = ret.resultConversation._id || (ret.resultConversation as any).id
        }
        return ret
      }
    }
  }
)

// add plugin that converts mongoose to json
experimentSchema.plugin(toJSON)
experimentSchema.plugin(paginate)

// index timestamps
experimentSchema.index({ createdAt: 1 })
experimentSchema.index({ updatedAt: 1 })

const Experiment = mongoose.model('Experiment', experimentSchema)
export default Experiment
