import { ChatPostMessageResponse } from '@slack/web-api'
import logger from '../../../config/logger.js'
import slackClientPool from './slackClientPool.js'
import { AdapterMessage } from '../../../types/adapter.types.js'

async function receiveGroupChatMessage(event) {
  const msg: AdapterMessage<string> = {
    message: event.text,
    source: 'slack',
    channels: this.chatChannels,
    user: { username: `${event.team}-${event.user}`, pseudonym: event.user }
  }
  return [msg]
}

async function receiveDirectMesssage(event) {
  const msg: AdapterMessage<string> = {
    message: event.text,
    source: 'slack',
    channels: this.dmChannels,
    user: { username: `${event.team}-${event.user}`, pseudonym: event.user, dmConfig: { channel: event.channel } }
  }
  return [msg]
}

export default {
  name: 'slack',
  label: 'Slack',
  async sendMessage(message, channelConfig?) {
    const channel = channelConfig?.channel ? channelConfig?.channel : this.config.channel
    // usernames are IDs in Slack, enclose in brackets for the proper display name to show in Slack
    const text = message.body.replace(/@(\w+)/g, '<@$1>')
    const slackWebClient = slackClientPool.getClient(this.config.workspace, this.config.botToken)
    const result = (await slackWebClient.chat.postMessage({
      channel,
      text
    })) as ChatPostMessageResponse
    if (!result.ok) {
      throw new Error(`Slack message failed to send: ${result.error}`)
    }
  },
  async receiveMessage(event) {
    if (event.channel_type === 'im') {
      return await receiveDirectMesssage.call(this, event)
    }
    return await receiveGroupChatMessage.call(this, event)
  },

  async start() {
    // no-op
  },
  async stop() {
    // no-op
  },
  async validateBeforeUpdate() {
    ;['channel', 'workspace', 'botToken'].forEach((key) => {
      if (!this.config?.[key]) {
        throw Error(`Slack ${key} required in adapter config`)
      }
    })
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async participantJoined(participant) {
    // no-op for now. Agents do not DM participants until they receive a DM
  },
  async getChannels(message) {
    const isDM = message.channel_type === 'im'
    if (isDM && !this.conversation.enableDMs.includes('agents')) {
      logger.warn('Received DM from participant, but DMs are not enabled for agents in this conversation.')
      return []
    }
    return isDM ? this.dmChannels : this.chatChannels
  },
  getUniqueKeys() {
    return ['type', 'config.channel', 'config.workspace']
  }
}
