import { ChatPostMessageResponse } from '@slack/web-api'
import logger from '../../config/logger.js'
import slackClientPool from './slackClientPool.js'
import { AdapterMessage } from '../../types/adapter.types.js'
import { Message } from '../../models/index.js'

function normalizeBotMention(text: string, botUserId: string, botName: string): string {
  if (!botUserId || !botName) return text
  // Slack HTML-encodes angle brackets in event payloads: &lt;@USER_ID&gt;
  const escapedId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // eslint-disable-next-line security/detect-non-literal-regexp
  return text.replace(new RegExp(`(?:&lt;|<)@${escapedId}(?:&gt;|>)`, 'g'), `@${botName}`)
}

async function findThreadParent(conversationId, threadTs) {
  const parent = await Message.findOne({ conversation: conversationId, 'source.id': threadTs }).select('_id').exec()
  return parent?._id ?? null
}

async function receiveGroupChatMessage(event) {
  const msg: AdapterMessage<string> = {
    message: normalizeBotMention(event.text, this.config.botUserId, this.config.botName),
    source: { type: 'slack', id: event.ts },
    channels: this.chatChannels,
    user: { username: `${event.team}-${event.user}`, pseudonym: event.user }
  }
  if (event.thread_ts && event.thread_ts !== event.ts) {
    const parentId = await findThreadParent(this.conversation._id, event.thread_ts)
    if (parentId) msg.parentMessage = parentId.toString()
  }
  return [msg]
}

async function receiveDirectMesssage(event) {
  const msg: AdapterMessage<string> = {
    message: normalizeBotMention(event.text, this.config.botUserId, this.config.botName),
    source: { type: 'slack', id: event.ts },
    channels: this.dmChannels,
    user: { username: `${event.team}-${event.user}`, pseudonym: event.user, dmConfig: { channel: event.channel } }
  }
  if (event.thread_ts && event.thread_ts !== event.ts) {
    const parentId = await findThreadParent(this.conversation._id, event.thread_ts)
    if (parentId) msg.parentMessage = parentId.toString()
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

    let threadTs: string | undefined
    if (message.parentMessage) {
      const parent = await Message.findById(message.parentMessage).select('source').exec()
      threadTs = parent?.source?.id
    }

    const result = (await slackWebClient.chat.postMessage({
      channel,
      text,
      ...(threadTs && { thread_ts: threadTs })
    })) as ChatPostMessageResponse
    if (!result.ok) {
      throw new Error(`Slack message failed to send: ${result.error}`)
    }
    if (message._id && result.ts) {
      await Message.findByIdAndUpdate(message._id, { $set: { 'source.id': result.ts } }).exec()
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
