import mongoose from 'mongoose'
import { IAgentIntroduction } from '../types/index.types.js'

/* A DM greeting is a live LLM call, so later joins replay the saved greeting instead of asking the
   agent again. Kept apart from ConversationMembership because
   membership records only exist for conversations that enforce a roster, and its `introduced`
   flag already means something else: featured in a community assistant member-intro round. */
const schema = new mongoose.Schema<IAgentIntroduction>(
  {
    conversation: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Conversation',
      required: true
    },
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: true
    },
    agent: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'Agent',
      required: true
    },
    channel: {
      type: String,
      required: true
    },
    intros: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    }
  },
  {
    timestamps: true
  }
)

schema.index({ conversation: 1, user: 1, agent: 1, channel: 1 }, { unique: true })

const AgentIntroduction = mongoose.model('AgentIntroduction', schema)
export default AgentIntroduction
