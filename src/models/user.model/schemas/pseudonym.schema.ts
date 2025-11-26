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
  }
})
export default pseudonymSchema
