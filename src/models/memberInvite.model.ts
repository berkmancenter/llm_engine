import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import { IMemberInvite } from '../types/index.types.js'

/* Only hashes are stored, never the raw invite token or nonce: a database read must not
   hand over live account-provisioning capability. Both are marked private so toJSON
   strips even the hashes from any API response. */
const schema = new mongoose.Schema<IMemberInvite>(
  {
    membership: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'ConversationMembership',
      required: true,
      index: true
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      private: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    consumedAt: {
      type: Date,
      default: null
    },
    invalidatedAt: {
      type: Date,
      default: null
    },
    nonceHash: {
      type: String,
      default: null,
      private: true
    },
    nonceExpiresAt: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
)

schema.plugin(toJSON)

const MemberInvite = mongoose.model('MemberInvite', schema)
export default MemberInvite
