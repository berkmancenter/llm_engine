import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'
import { IFollower } from '../types/index.types.js'

const schema = new mongoose.Schema<IFollower>(
  {
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: true,
      index: true
    },
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      index: true
    },
    topic: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Topic',
      index: true
    }
  },
  {
    timestamps: true
  }
)
// add plugin that converts mongoose to json
schema.plugin(toJSON)
schema.plugin(paginate)
/**
 * @typedef Follower
 */
const Follower = mongoose.model('Follower', schema)
export default Follower
