import mongoose from 'mongoose'
import { toJSON } from './plugins/index.js'
import tokenTypes from '../config/tokens.js'

const tokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      index: true
    },
    user: {
      type: mongoose.SchemaTypes.ObjectId,
      ref: 'BaseUser',
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [tokenTypes.REFRESH, tokenTypes.RESET_PASSWORD, tokenTypes.VERIFY_EMAIL, tokenTypes.ARCHIVE_TOPIC],
      required: true,
      index: true
    },
    expires: {
      type: Date,
      required: true,
      index: true
    },
    blacklisted: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: true
  }
)
// add plugin that converts mongoose to json
tokenSchema.plugin(toJSON)
/**
 * @typedef Token
 */
const Token = mongoose.model('Token', tokenSchema)
export default Token
