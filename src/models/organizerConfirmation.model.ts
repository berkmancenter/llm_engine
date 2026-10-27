import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import { IOrganizerConfirmation } from '../types/index.types.js'

/* Only hashes are stored, never the raw confirmation token or nonce: a database read must not
   hand over the ability to confirm on the real organizer's behalf. Both are marked private so
   toJSON strips even the hashes from any API response. */
const schema = new mongoose.Schema<IOrganizerConfirmation>(
  {
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
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
      required: true,
      index: true
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

const OrganizerConfirmation = mongoose.model('OrganizerConfirmation', schema)
export default OrganizerConfirmation
