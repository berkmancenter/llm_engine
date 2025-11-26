import { User } from '../models/index.js'
import { AdapterMessage, AdapterUser } from '../types/adapter.types.js'
import userService from './user.service.js'
import messageService from './message.service.js'
import conversationService from './conversation.service.js'
import logger from '../config/logger.js'

async function getOrCreateUser(adapter, adapterUser) {
  let user = await User.findOne({ username: adapterUser.username })
  if (!user) {
    user = await User.create({
      username: adapterUser.username,
      pseudonyms: [
        {
          token: userService.newToken(),
          pseudonym: adapterUser.pseudonym || (await userService.newPseudonym(0)),
          active: true
        }
      ]
    })
  }
  // update dmConfig by direct channel name, to be used later to send DMs
  let channelsUpdated = false
  const updatedDmChannels = adapter.dmChannels.map((dmChannelConfig) => {
    if (dmChannelConfig.direct && dmChannelConfig.agent) {
      const directChannelName = `direct-${user._id}-${dmChannelConfig.agent}`
      // Assumes user's ID won't change throughout the conversation
      if (!dmChannelConfig.config?.[directChannelName]) {
        channelsUpdated = true
        return {
          ...dmChannelConfig,
          config: {
            ...(dmChannelConfig.config || {}),
            [directChannelName]: adapterUser.dmConfig
          }
        }
      }
    }
    return dmChannelConfig
  })
  if (channelsUpdated) {
    // eslint-disable-next-line no-param-reassign
    adapter.dmChannels = updatedDmChannels
    await adapter.save()
  }
  // this will create direct channels between the user and all agents in the conversation if they do not already exist
  await conversationService.joinConversation(adapter.conversation, user)
  return user
}

const receiveMessage = async (adapter, message) => {
  const adapterMsgs: AdapterMessage<string>[] = await adapter.receiveMessage(message)
  for (const adapterMsg of adapterMsgs) {
    const user = await getOrCreateUser(adapter, adapterMsg.user)
    const channels: Record<string, unknown>[] = []
    for (const msgChannel of adapterMsg.channels) {
      const channelName = msgChannel.name ?? `direct-${user._id}-${msgChannel.agent}`
      const channel = adapter.conversation.channels.find((c) => c.name === channelName)
      if (channel) {
        channels.push(channel)
      } else {
        logger.warn(`Unable to receive message on specified channel ${channelName}. Channel not found in Conversation.`)
      }
    }
    if (channels.length > 0) {
      const msg = {
        conversation: adapter.conversation,
        channels: channels.map((c) => ({ name: c.name, passcode: c.passcode })),
        body: adapterMsg.message,
        source: adapterMsg.source,
        bodyType: adapterMsg.messageType || 'text',
        ...(adapterMsg.createdAt !== undefined && { createdAt: adapterMsg.createdAt })
      }
      await messageService.newMessageHandler(msg, user)
    }
  }
}

const participantJoined = async (adapter, participant) => {
  const adapterUser: AdapterUser = await adapter.participantJoined(participant)
  if (adapterUser) {
    await getOrCreateUser(adapter, adapterUser)
  }
}

const webhookService = { receiveMessage, participantJoined }
export default webhookService
