import mongoose from 'mongoose'

/* Backs real-name uniqueness: one row per (conversation, real name) pair, reserved by
   userService.createUser before a real-name pseudonym entry is created. Deliberately
   a dedicated collection with a real compound-unique index,
   rather than a $elemMatch scan over every User's embedded pseudonyms array —
   `pseudonyms.normalizedPseudonym` and `pseudonyms.conversations` can't be compounded
   into one index (conversations is itself an array nested in an array of
   subdocuments; Mongo rejects a compound multikey index across two array paths in
   the same document), so that approach could only index one field and would filter
   the rest in memory, unscoped by conversation until after the fetch.

   The unique index also closes the check-then-insert race a plain existence check
   would leave open: reserving a name is one atomic insert that either succeeds or
   fails on the index, never a separate check followed by a separate write. */
const realNameRegistrySchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true
    },
    normalizedPseudonym: {
      type: String,
      required: true
    },
    // Set once the User this reservation belongs to has been created (see
    // userService.createUser — the reservation is made before the user exists).
    userId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      index: true
    }
  },
  { timestamps: true }
)

realNameRegistrySchema.index({ conversationId: 1, normalizedPseudonym: 1 }, { unique: true })

/**
 * @typedef RealNameRegistry
 */
const RealNameRegistry = mongoose.model('RealNameRegistry', realNameRegistrySchema)

export default RealNameRegistry
