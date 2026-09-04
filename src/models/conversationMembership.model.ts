import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'
import { IConversationMembership } from '../types/index.types.js'

const schema = new mongoose.Schema<IConversationMembership>(
  {
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    bio: {
      type: String,
      trim: true,
      default: ''
    },
    interests: {
      type: String,
      trim: true,
      default: ''
    },
    // Set by a future invite ticket; import only ever creates records as 'pending' and
    // never advances or resets this on re-import (re-importing must never re-invite).
    inviteState: {
      type: String,
      enum: ['pending', 'invited'],
      default: 'pending'
    },
    joined: {
      type: Boolean,
      default: false
    },
    // Set by future membership-management action(s), never by import. A membership missing from
    // a later import file is left in place, not marked removed.
    status: {
      type: String,
      enum: ['active', 'removed'],
      default: 'active'
    },
    // Empty until the member first signs in and links their account; the record exists
    // before the account does. Same "required: false" shape as Message.owner.
    userAccount: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: false,
      index: true
    },
    // Keyed by adapter type (e.g. 'slack', 'zoom') — stores the external platform's user ID
    // so incoming messages from adapters that identify users differently than by email can still
    // be routed to the right account.
    externalIds: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined
    },
    introduced: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
)

// One record per conversation + email; re-importing the same email updates it in place.
// Differences in casing/whitespace already collapse before save (email is trim+lowercase).
schema.index({ conversation: 1, email: 1 }, { unique: true })

schema.plugin(toJSON)
schema.plugin(paginate)

const ConversationMembership = mongoose.model('ConversationMembership', schema)
export default ConversationMembership
