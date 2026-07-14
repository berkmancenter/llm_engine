import mongoose, { HydratedDocument, Model } from 'mongoose'
import slugify from 'slugify'

import { toJSON, paginate, lock, hasPdf } from './plugins/index.js'
import { IConversation, Profile, Resource } from '../types/index.types.js'
import Message from './message.model.js'
import transcriptSchema from './schemas/transcript.schema.js'

interface ConversationMethods {
  messageCount(): number
}

type ConversationModel = Model<IConversation, Record<string, never>, ConversationMethods>

/* Resources are embedded rather than standalone: they are never queried outside their
   conversation, have no independent lifecycle, and cascade-delete naturally with the parent. */
const resourceSchema = new mongoose.Schema<Resource>({
  source: { type: String, enum: ['speaker', 'ai'], required: true },
  category: { type: String, enum: ['required', 'referenced', 'suggested'], required: true },
  title: { type: String, required: true },
  authors: { type: [String] },
  year: { type: String },
  url: { type: String },
  fileName: { type: String, private: true },
  citation: { type: String },
  description: { type: String },
  summary: { type: String },
  relevanceReason: { type: String },
  participantVisible: { type: Boolean, default: true },
  addedAt: { type: Date, default: Date.now }
})
resourceSchema.plugin(toJSON)
/* hasPdf must run after toJSON so it can read fileName from doc after toJSON
   has already stripped it from ret. */
resourceSchema.plugin(hasPdf)

const profileSchema = new mongoose.Schema<Profile>(
  {
    name: {
      type: String,
      required: true
    },
    bio: {
      type: String,
      required: false
    },
    alternateName: {
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
      required: false
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
    /* Fail-closed default: an unsaved or bypassed-service-layer conversation is treated as
       Draft until conversation.service explicitly computes and sets the real value. */
    draft: {
      type: Boolean,
      default: true
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
    scheduledEndTime: {
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
    // Which analytics source holds this event's data, by name. A Matomo "segment"
    // is a saved filter that isolates this event's visits, e.g. { matomo: "<segment id>" }.
    analyticsRefs: {
      type: Map,
      of: String,
      default: undefined
    },
    transcript: transcriptSchema,
    adapters: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Adapter' }],
    followers: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Follower' }],
    agents: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Agent' }],
    channels: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Channel' }],
    experiments: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Experiments' }],
    properties: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    features: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },
    resources: {
      type: [resourceSchema],
      default: []
    },
    summary: {
      type: String,
      default: ''
    }
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
