import httpStatus from 'http-status'
import { Channel } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import agentService from './agent.service/index.js'

const createChannel = async (conversation, channelProps) => {
  const enableDMs = conversation.enableDMs ?? []
  if (enableDMs.length === 0 && channelProps.direct === true) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot create direct channels when DMs are disabled')
  }

  const channel = await Channel.create(channelProps)
  conversation.channels.push(channel)
  await conversation.save()
  await agentService.introduceAgents(conversation.agents, channel)
  return channel
}

const channelService = { createChannel }
export default channelService
