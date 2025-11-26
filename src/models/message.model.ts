import mongoose, { Model } from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'
import { IMessage, Vote } from '../types/index.types.js'

const voteSchema = new mongoose.Schema<Vote>({
  owner: {
    type: mongoose.SchemaTypes.ObjectId,
    ref: 'BaseUser',
    required: false
  },
  pseudonym: {
    type: String,
    required: false
  },
  reason: {
    type: String,
    required: false
  }
})

export interface MessageMethods {
  parseOutput?: (msg: IMessage) => IMessage
}
type MessageModel = Model<IMessage, Record<string, never>, MessageMethods>
const messageSchema = new mongoose.Schema<IMessage, MessageModel>(
  {
    body: {
      type: mongoose.SchemaTypes.Mixed,
      required: true
    },
    bodyType: {
      type: String,
      required: true,
      enum: ['text', 'json'],
      default: 'text'
    },
    owner: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: false,
      index: true
    },
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    upVotes: {
      type: [voteSchema],
      default: []
    },
    downVotes: {
      type: [voteSchema],
      default: []
    },
    pseudonym: {
      type: String,
      required: true
    },
    pseudonymId: {
      type: mongoose.SchemaTypes.ObjectId,
      required: true,
      index: true
    },
    // from a non-human agent
    fromAgent: {
      type: Boolean,
      index: true
    },
    // when injected from external source
    source: {
      type: String
    },
    // optional channel(s) designation
    channels: {
      type: [String],
      index: true
    },
    // to help with backchannel interactions/data handling
    visible: {
      type: Boolean,
      default: true,
      required: true,
      index: true
    },
    parentMessage: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Message'
    }
  },
  {
    timestamps: true
  }
)

// add plugin that converts mongoose to json
messageSchema.plugin(toJSON)
messageSchema.plugin(paginate)
// index timestamps
messageSchema.index({ createdAt: 1 })
messageSchema.index({ updatedAt: 1 })
/**
 * @typedef User
 */
const Message = mongoose.model<IMessage, MessageModel>('Message', messageSchema)
export default Message
