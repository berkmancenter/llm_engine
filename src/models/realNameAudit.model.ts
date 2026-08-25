import mongoose from 'mongoose'
import { toJSON, paginate } from './plugins/index.js'

/* Audit trail for real-name pseudonym entries — never the name text itself, only who/
   what/when — so a compromised account probing for names, or repeated attempts to
   activate/delete a real-name entry, leave a record to investigate. Modeled on
   ExportAudit's precedent for auditing sensitive per-user operations. */
const realNameAuditSchema = new mongoose.Schema(
  {
    // Absent for a rejection that happens before an account exists yet (a failed
    // passcode or uniqueness check during registration).
    userId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      index: true
    },
    conversationId: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true
    },
    action: {
      type: String,
      enum: ['created', 'activate_rejected', 'delete_rejected', 'passcode_rejected', 'uniqueness_rejected'],
      required: true,
      index: true
    }
  },
  {
    timestamps: true
  }
)

realNameAuditSchema.plugin(toJSON)
realNameAuditSchema.plugin(paginate)

/**
 * @typedef RealNameAudit
 */
const RealNameAudit = mongoose.model('RealNameAudit', realNameAuditSchema)

export default RealNameAudit
