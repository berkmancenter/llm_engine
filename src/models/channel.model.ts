import { nanoid } from 'nanoid'
import mongoose, { Model } from 'mongoose'
import { IChannel, IMessage } from '../types/index.types.js'

const PASSCODE_LENGTH = 8

interface ChannelMethods {
  sendMessage(message: IMessage)
}

type ChannelModel = Model<IChannel, Record<string, never>, ChannelMethods>

const breakoutSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true },
    roundId: { type: String, required: true },
    name: { type: String },
    description: { type: String },
    active: { type: Boolean, default: true },
    parentChannel: { type: String },
    type: { type: String, enum: ['chat', 'transcript'] }
  },
  { _id: false }
)

const channelSchema = new mongoose.Schema<IChannel, ChannelModel>({
  name: {
    type: String,
    required: true
  },
  passcode: {
    type: String,
    required: false,
    // defaults to present and used for safety, but you can pass `passcode: null` to disable it for a channel if desired
    default: () => nanoid(PASSCODE_LENGTH)
  },
  direct: {
    type: Boolean,
    default: false
  },
  participants: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'BaseUser',
    default: undefined
  },
  breakout: {
    type: breakoutSchema,
    default: undefined
  }
})

channelSchema.pre('validate', async function () {
  if (this.direct && (!this.participants || this.participants.length !== 2)) {
    throw new Error('Direct channels must have exactly 2 participants')
  }
})

/**
 * @typedef Channel
 */
const Channel = mongoose.model<IChannel, ChannelModel>('Channel', channelSchema)

export default Channel
