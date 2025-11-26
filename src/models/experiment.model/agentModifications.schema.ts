import mongoose from 'mongoose'

const agentModificationsSchema = new mongoose.Schema({
  agent: {
    type: mongoose.SchemaTypes.ObjectId,
    ref: 'Agent',
    required: true
  },
  experimentValues: {
    type: mongoose.SchemaTypes.Mixed
  },
  simulatedStartTime: {
    type: Date
  }
})

export default agentModificationsSchema
