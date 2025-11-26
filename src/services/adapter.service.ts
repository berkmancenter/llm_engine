import httpStatus from 'http-status'
import { Adapter } from '../models/index.js'
import ApiError from '../utils/ApiError.js'

export const maxScheduledInterval = 10 * 60 * 1000 // 10 minutes in milliseconds

const start = async (adapter) => {
  const keys = Adapter.getUniqueKeys(adapter.type)
  const query = {
    ...Object.fromEntries(keys.map((key) => [key, key.split('.').reduce((obj, k) => obj?.[k], adapter)])),
    active: true,
    conversation: { $ne: adapter.conversation }
  }

  const adapters = await Adapter.find(query)
  if (adapters.length > 0) {
    throw new Error(
      `Cannot start adapter. Another conversation with the same unique keys: ${keys.join(', ')} is currently active.`
    )
  }
  await adapter.start()
}

const stop = async (adapter) => {
  await adapter.stop()
}

const createAdapter = async (adapter, conversation) => {
  if (conversation.scheduledTime) {
    const keys = Adapter.getUniqueKeys(adapter.type)
    const query = Object.fromEntries(keys.map((key) => [key, key.split('.').reduce((obj, k) => obj?.[k], adapter)]))
    const adapters = await Adapter.find({
      ...query,
      conversation: { $ne: conversation._id }
    }).populate('conversation')

    if (adapters.length > 0) {
      const startTime = new Date(conversation.scheduledTime.getTime() - maxScheduledInterval)
      const endTime = new Date(conversation.scheduledTime.getTime() + maxScheduledInterval)

      const conversationAdapters = adapters.filter(
        (a) => a.conversation.scheduledTime! >= startTime && a.conversation.scheduledTime! <= endTime
      )
      if (conversationAdapters.length > 0) {
        throw new ApiError(
          httpStatus.BAD_REQUEST,
          `Cannot create a Conversation scheduled for +- ${
            maxScheduledInterval / (60 * 1000)
          } minutes within another Conversation with same unique adapter keys: ${keys.join(', ')}`
        )
      }
    }
  }
  for (const dmChannel of adapter.dmChannels || []) {
    // Update agent reference for future direct channel creation
    if (dmChannel.direct) {
      if (conversation.enableDMs.length === 0) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'Adapter cannot use direct channels when DMs are disabled')
      }
      const dmAgent = conversation.agents.find((a) => a.agentType === dmChannel.agent)?._id
      if (!dmAgent) {
        throw new ApiError(httpStatus.BAD_REQUEST, `No agent of type ${dmChannel.agent} found for direct channel`)
      }
      dmChannel.agent = dmAgent
    }
  }

  const conversationAdapter = new Adapter({
    type: adapter.type,
    config: adapter.config,
    audioChannels: adapter.audioChannels,
    chatChannels: adapter.chatChannels,
    dmChannels: adapter.dmChannels,
    conversation
  })

  await conversationAdapter.save()

  return conversationAdapter
}

const adapterService = { start, stop, createAdapter }
export default adapterService
