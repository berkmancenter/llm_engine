import mongoose from 'mongoose'
import { toJSON, paginate } from '../plugins/index.js'
import { IPollChoice } from '../../types/index.types.js'

const pollChoiceSchema = new mongoose.Schema<IPollChoice>(
  {
    text: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    poll: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Poll',
      required: true,
      private: false,
      index: true
    }
  },
  {
    timestamps: true
  }
)
// add plugin that converts mongoose to json
pollChoiceSchema.plugin(toJSON)
pollChoiceSchema.plugin(paginate)
/**
 * @typedef pollChoice
 */
const pollChoice = mongoose.model('PollChoice', pollChoiceSchema)
export default pollChoice
