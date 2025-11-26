import httpStatus from 'http-status'
import mongoose from 'mongoose'
import ApiError from './ApiError.js'
import Conversation from '../models/conversation.model.js'
import { IConversation } from '../types/index.types.js'

export default async function authChannels(channels, conversation: IConversation | mongoose.Types.ObjectId | string, user?) {
  let allowedChannels
  let fullConversation
  if (typeof conversation === 'string' || conversation instanceof mongoose.Types.ObjectId) {
    fullConversation = await Conversation.findById(conversation).select('channels').populate('channels').exec()
    if (!fullConversation) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
    }
    allowedChannels = fullConversation.channels || []
  } else {
    fullConversation = conversation as IConversation
    await fullConversation.populate('channels')
    allowedChannels = fullConversation.channels
  }

  for (const channel of channels || []) {
    const allowedChannel = allowedChannels?.find((c) => c.name === channel.name)
    if (!allowedChannel) throw new ApiError(httpStatus.BAD_REQUEST, `No such channel on this conversation: ${channel.name}`)
    if (allowedChannel.passcode && channel.passcode !== allowedChannel.passcode)
      throw new ApiError(httpStatus.BAD_REQUEST, `Incorrect passcode for channel: ${channel.name}`)
    if (
      allowedChannel.direct &&
      (!user || !allowedChannel.participants.some((p) => p._id.toString() === user._id.toString()))
    ) {
      throw new ApiError(
        httpStatus.UNAUTHORIZED,
        `Channel access denied. User is not a participant in direct channel: ${channel.name}`
      )
    }
  }
}
