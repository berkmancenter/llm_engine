import httpStatus from 'http-status'
import config from '../config/config.js'
import logger from '../config/logger.js'
import { AdapterMessage, AdapterUser } from '../types/adapter.types.js'

const defaultBotName = 'LLM Engine'
const defaultRetention = {
  type: 'timed',
  hours: 1
}

async function isBotDeployed() {
  const { botId } = this.config
  const options = { method: 'GET', headers: { accept: 'application/json', Authorization: config.recall.key } }

  const response = await fetch(`${config.recall.baseUrl}/${botId}`, options)
  if (response.status !== httpStatus.OK) {
    logger.error(`Error checking if bot ${botId} is deployed. Deploying new one. Error: ${await response.text()}`)
    return false
  }

  const responseJson: unknown = await response.json()
  const statusChanges = (responseJson as { status_changes: Record<string, unknown>[] }).status_changes
  if (statusChanges.length === 0) {
    // Not sure we would ever get a bot with no status, but just in case
    logger.info(`Found an existing bot with no status. ID: ${botId}. Deploying new bot.`)
    return false
  }
  const recentStatus = statusChanges[statusChanges.length - 1]
  // If a bot times out in the waiting room, its status will be done
  if (
    recentStatus.code === 'done' ||
    recentStatus.code === 'fatal' ||
    recentStatus.code === 'media_expired' ||
    recentStatus.code === 'call_ended'
  ) {
    logger.info(`Found an existing bot that is no longer active. ID: ${botId}. Deploying new bot.`)
    return false
  }
  logger.info(`Found active bot with ID: ${botId}`)
  return true
}
async function deployMeetingBot() {
  const { meetingUrl, botName, botId, retention } = this.config
  if (botId === 'loadtest') {
    logger.info(`[LOAD TEST] Skipping deployment of Zoom meeting bot.`)
    return
  }
  if (!botId || !(await isBotDeployed.call(this))) {
    const realtimeEndpoints: Record<string, unknown>[] = [
      {
        type: 'webhook',
        events: ['participant_events.chat_message'],
        url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/chat/?token=${config.recall.token}&conversationId=${this.conversation._id}`
      },
      {
        type: 'webhook',
        events: ['participant_events.join'],
        url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/join/?token=${config.recall.token}&conversationId=${this.conversation._id}`
      }
    ]

    let recordingConfig = {}
    const audioChannelNames = this.audioChannels?.map((c) => c.name) || []
    if (this.audioChannels && this.conversation.channels.some((channel) => audioChannelNames.includes(channel.name))) {
      realtimeEndpoints.push({
        type: 'webhook',
        events: ['transcript.data'],
        url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/transcript/?token=${config.recall.token}&conversationId=${this.conversation._id}`
      })
      recordingConfig = {
        transcript: {
          provider: {
            meeting_captions: {}
          }
        }
      }
    }
    const options = {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: config.recall.key },
      body: JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: botName ?? defaultBotName,
        recording_config: {
          ...recordingConfig,
          realtime_endpoints: realtimeEndpoints,
          retention: 'retention' in this.config ? retention : defaultRetention
        },
        ...(config.zoom?.webinarUserEmail && {
          zoom: {
            user_email: config.zoom.webinarUserEmail
          }
        })
      })
    }

    const response = await fetch(config.recall.baseUrl, options)
    if (response.status !== httpStatus.CREATED) {
      logger.error(`Recall error: ${await response.text()}`)
      throw new Error(`Error deploying bot to Zoom meeting: ${response.status}`)
    }

    const responseJson: unknown = await response.json()
    this.config = { ...this.config, botId: (responseJson as { id: string }).id }
    await this.save()
  }
}

async function processTranscript(msgChunks, participantName) {
  const msgs: AdapterMessage<string>[] = []
  for (const msgChunk of msgChunks) {
    msgs.push({
      channels: this.audioChannels,
      message: msgChunk.text,
      source: 'zoom',
      createdAt: new Date(msgChunk.end_timestamp.absolute),
      user: { username: participantName }
    })
  }
  return msgs
}

async function receiveGroupChatMessage(data) {
  const msg: AdapterMessage<string> = {
    message: data.data.data.text,
    source: 'zoom',
    channels: this.chatChannels,
    user: { username: data.data.participant.name }
  }
  return [msg]
}

async function receiveDirectMesssage(data) {
  const msg: AdapterMessage<string> = {
    message: data.data.data.text,
    source: 'zoom',
    channels: this.dmChannels,
    user: { username: data.data.participant.name, dmConfig: { to: data.data.participant.id } }
  }
  return [msg]
}

async function receiveChatMessage(data) {
  const isDM = data.data.data.to === 'only_bot'
  let message
  if (isDM) {
    message = await receiveDirectMesssage.call(this, data)
  } else {
    message = await receiveGroupChatMessage.call(this, data)
  }
  return message
}

export default {
  name: 'zoom',
  label: 'Zoom',
  async sendMessage(message, channelConfig?) {
    if (this.config.botId === 'loadtest') {
      logger.info(`[LOAD TEST] Would send message: ${message.body}`)
      // Simulate API delay without actually calling
      await new Promise((resolve) => setTimeout(resolve, 100)) // Simulate 100ms API latency
      return
    }
    const options = {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: config.recall.key },
      body: JSON.stringify({
        message: message.body,
        ...(channelConfig?.to ? { to: channelConfig.to } : {})
      })
    }
    logger.debug(
      `Sending message to Zoom via Recall: ${message.body} to ${channelConfig?.to ? channelConfig.to : 'everyone'}`
    )
    const response = await fetch(`${config.recall.baseUrl}/${this.config.botId}/send_chat_message/`, options)
    if (response.status !== httpStatus.OK) {
      throw new Error(`Error sending chat message to Zoom meeting: ${response.status}`)
    }
  },

  async receiveMessage(message) {
    const { event, data } = message
    let messages = []
    if (event === 'transcript.data') {
      messages = await processTranscript.call(this, data.data.words, data.data.participant.name)
    } else if (event === 'participant_events.chat_message') {
      messages = await receiveChatMessage.call(this, data)
    }
    return messages
  },
  async start() {
    await deployMeetingBot.call(this)
  },

  async stop() {
    // Remove bot from meeting
    const options = {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', Authorization: config.recall.key }
    }
    const url = `${config.recall.baseUrl}/${this.config.botId}/leave_call/`
    const response = await fetch(url, options)
    if (response.status !== httpStatus.OK) {
      // TODO this happens if adapter is stopped after meeting has ended
      // Ideally we check if bot is in meeting and only attempt to remove if true
      // Unfortunately the 'Retrieve Bot' endpoint seems to remove the bot from the call
      // instead of returning status information
      logger.error(`Error removing bot from Zoom meeting: ${response.status}. Recall error: ${await response.text()}`)
    }
    // Remove Bot ID
    this.config = { ...this.config, botId: undefined }
    await this.save()
  },
  async validateBeforeUpdate() {
    if (!this.config?.meetingUrl) {
      throw Error('Zoom meeting URL required in adapter config')
    }
  },
  async participantJoined(participant) {
    if (!this.conversation.populated('adapters')) {
      await this.conversation.populate('adapters')
    }
    const bots = this.conversation.adapters.filter((adapter) => adapter.type === 'zoom' && adapter.config?.botName)
    const botNames = bots.map((bot) => bot.config?.botName)
    botNames.push(defaultBotName)
    // Ignore if participant is one of the bots
    if (!botNames.includes(participant.name)) {
      const adapterUser: AdapterUser = { username: participant.name, dmConfig: { to: participant.id } }
      return adapterUser
    }
  },
  async getChannels(message) {
    const { event, data } = message
    let channels = []
    if (event === 'transcript.data') {
      channels = this.audioChannels
    }
    if (event === 'participant_events.chat_message') {
      const isDM = data.data.data.to === 'only_bot'
      if (isDM && !this.conversation.enableDMs.includes('agents')) {
        logger.warn('Received DM from participant, but DMs are not enabled for agents in this conversation.')
      } else {
        channels = isDM ? this.dmChannels : this.chatChannels
      }
    }
    return channels
  },
  getUniqueKeys() {
    return ['type', 'config.meetingUrl']
  }
}
