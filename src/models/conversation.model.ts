import mongoose, { HydratedDocument, Model } from 'mongoose'
import slugify from 'slugify'

import { toJSON, paginate, lock } from './plugins/index.js'
import { IConversation, Profile } from '../types/index.types.js'
import Message from './message.model.js'

interface ConversationMethods {
  messageCount(): number
}

type ConversationModel = Model<IConversation, Record<string, never>, ConversationMethods>

const profileSchema = new mongoose.Schema<Profile>(
  {
    name: {
      type: String,
      required: true
    },
    bio: {
      type: String,
      required: false
    }
  },
  {
    _id: false
  }
)

const conversationSchema = new mongoose.Schema<IConversation, ConversationModel>(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    slug: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    description: {
      type: String,
      trim: true
    },
    moderators: { type: [profileSchema], default: [] },
    presenters: { type: [profileSchema], default: [] },
    conversationType: {
      type: String,
      trim: true,
      required: false,
      immutable: true
    },
    platforms: {
      type: [String],
      required: false,
      default: []
    },
    locked: {
      type: Boolean,
      default: false,
      index: true
    },
    enableAgents: {
      type: Boolean,
      default: false,
      index: true
    },
    enableDMs: {
      type: [String],
      enum: ['users', 'agents'],
      default: [],
      index: true
    },
    active: {
      type: Boolean,
      default: false
    },
    owner: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: true,
      private: false,
      index: true
    },
    topic: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Topic',
      required: true,
      index: true
    },
    scheduledTime: {
      type: Date
    },
    startTime: {
      type: Date
    },
    endTime: {
      type: Date
    },
    experimental: {
      type: Boolean,
      default: false
    },
    // TODO turn this into a first class object later
    transcript: {
      vectorStore: {
        embeddingsPlatform: {
          type: String
        },
        embeddingsModelName: {
          type: String
        }
      }
    },
    adapters: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Adapter' }],
    followers: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Follower' }],
    agents: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Agent' }],
    channels: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Channel' }],
    experiments: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Experiments' }]
  },
  {
    timestamps: true
  }
)

// virtual to allow messages to be populated in when desired
conversationSchema.virtual('messages', {
  ref: 'Message',
  localField: '_id',
  foreignField: 'conversation',
  justOne: false,
  options: { sort: { createdAt: 1 } }
})

// count related messages when desired
// default to visible, no replies
conversationSchema.method('messageCount', async function (query) {
  return Message.countDocuments({ visible: true, parentMessage: null, ...query, conversation: this._id }).exec()
})

// add plugin that converts mongoose to json
conversationSchema.plugin(toJSON)
conversationSchema.plugin(paginate)
conversationSchema.plugin(lock)
// index timestamps
conversationSchema.index({ createdAt: 1 })
conversationSchema.index({ updatedAt: 1 })
conversationSchema.pre('validate', function (next) {
  this.slug = slugify(this.name)
  next()
})
conversationSchema.post('findOne', async (doc) => {
  if (doc?.enableAgents) await doc?.populate('agents')
})

export type ConversationDocument = HydratedDocument<IConversation> & ConversationMethods
const Conversation = mongoose.model<IConversation, ConversationModel>('Conversation', conversationSchema)
export default Conversation
