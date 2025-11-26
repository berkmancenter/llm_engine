import mongoose, { HydratedDocument } from 'mongoose'
import slugify from 'slugify'
import { toJSON, paginate } from './plugins/index.js'
import { ITopic } from '../types/index.types.js'

const topicSchema = new mongoose.Schema<ITopic>(
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
    votingAllowed: {
      type: Boolean,
      required: true
    },
    conversationCreationAllowed: {
      type: Boolean,
      required: true
    },
    private: {
      type: Boolean,
      required: true,
      index: true // we query on this
    },
    passcode: {
      type: Number,
      private: true
    },
    archivable: {
      type: Boolean,
      required: true,
      index: true
    },
    archived: {
      type: Boolean,
      default: false,
      private: true,
      index: true
    },
    isDeleted: {
      type: Boolean,
      default: false,
      private: true,
      index: true // We need to query on this
    },
    isArchiveNotified: {
      type: Boolean,
      default: false,
      private: true,
      index: true
    },
    archiveEmail: {
      type: String
    },
    owner: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: true,
      index: true
    },
    conversations: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Conversation' }],
    // NOTE! polls are intentionally excluded from being saved here in order to prevent accidental disclosure of the
    // owner of a poll, which is sensitive information
    // really, we might want to consider moving all embedded document out and use a lookup instead
    // especially for messages on conversations, etc.
    // this could help with performance
    followers: [{ type: mongoose.SchemaTypes.ObjectId, ref: 'Follower' }]
  },
  {
    timestamps: true,
    toObject: {
      transform(doc, ret) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, __v, conversations, ...newRet } = ret
        return {
          ...newRet,
          id: _id.toString()
        }
      }
    }
  }
)
// add plugin that converts mongoose to json
topicSchema.plugin(toJSON)
topicSchema.plugin(paginate)
// index timestamps
topicSchema.index({ createdAt: 1 })
topicSchema.index({ updatedAt: 1 })
topicSchema.pre('validate', function (next) {
  this.slug = slugify(this.name)
  next()
})

export type TopicDocument = HydratedDocument<ITopic>
const Topic = mongoose.model<ITopic>('Topic', topicSchema)
export default Topic
