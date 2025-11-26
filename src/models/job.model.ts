import mongoose from 'mongoose'

const JobSchema = new mongoose.Schema({
  name: { type: String, required: true },
  conversationId: { type: String, required: true },
  lastProcessedAt: { type: Date, required: true },
  updatedAt: { type: Date, default: Date.now }
})

JobSchema.index({ name: 1, conversationId: 1 }, { unique: true })

const Job = mongoose.model('Job', JobSchema)
export default Job
