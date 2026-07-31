import mongoose from 'mongoose'

const experimentAgentSchema = new mongoose.Schema({
  // Reference to an existing agent on the base conversation
  agent: {
    type: mongoose.SchemaTypes.ObjectId,
    ref: 'Agent'
  },
  // Instantiate a new agent type instead of referencing an existing one
  agentType: {
    type: String
  },
  // Spread into the cloned/created agent to override defaults
  experimentValues: {
    type: mongoose.SchemaTypes.Mixed
  }
})

export default experimentAgentSchema
