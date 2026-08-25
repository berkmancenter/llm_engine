import mongoose from 'mongoose'
import { IPseudonym } from '../../../types/index.types.js'

const pseudonymSchema = new mongoose.Schema<IPseudonym>({
  token: {
    type: String,
    required: true,
    index: true
  },
  pseudonym: {
    type: String,
    required: true,
    index: true
  },
  active: {
    type: Boolean,
    index: true
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  conversations: {
    type: [String],
    default: []
  },
  funFact: {
    type: String
  },
  // See IPseudonym for the invariants this backs (never active, never deleted,
  // never counted against the pseudonym cap). Immutable so no later code path can
  // reclassify an entry after creation — see userSchema's pre('save') guard too.
  isRealName: {
    type: Boolean,
    default: false,
    index: true,
    immutable: true
  },
  // Stored for display/debug parity with what was actually reserved, but not
  // itself indexed or queried here — uniqueness is enforced by RealNameRegistry's
  // compound unique index (conversationId + normalizedPseudonym), not by scanning
  // this field across every user's embedded pseudonyms array. See
  // realNameRegistry.model.ts.
  normalizedPseudonym: {
    type: String,
    immutable: true
  }
})
export default pseudonymSchema
