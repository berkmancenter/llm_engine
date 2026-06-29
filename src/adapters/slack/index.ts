import { ChatPostMessageResponse } from '@slack/web-api'
import type { KnownBlock, Block } from '@slack/types'
import logger from '../../config/logger.js'
import slackClientPool from './client.js'
import { AdapterMessage } from '../../types/adapter.types.js'
import Message from '../../models/message.model.js'
import renderResponseBlocks from './blocks/index.js'

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
    /* Store Slack identity in source so it survives DB persistence.
       The user field is only used for auth lookup and is not saved. */
    source: { type: 'slack', id: event.ts, userId: event.user, teamId: event.team, channelId: event.channel },
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

function markdownToMrkdwn(text: string): string {
  return (
    text
      // Bold+italic first: ***text*** or ___text___ → *_text_*
      .replace(/\*\*\*(.+?)\*\*\*/gs, '*_$1_*')
      .replace(/___(.+?)___/gs, '*_$1_*')
      // Italic: *text* → _text_ (single asterisk only, won't match ** or *_..._*)
      .replace(/(?<!\*)\*(?![_*])(.+?)(?<![_*])\*(?!\*)/gs, '_$1_')
      // Bold: **text** or __text__ → *text*
      .replace(/\*\*(.+?)\*\*/gs, '*$1*')
      .replace(/__(.+?)__/gs, '*$1*')
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/gs, '~$1~')
      // Headings: # Heading → *Heading* (bold, since Slack has no headings)
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // Bullet points: "- text" or "* text" at start of line → "• text"
      .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
      // Links: [text](url) → <url|text>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
  )
}

export default {
  name: 'slack',
  label: 'Slack',
  async sendMessage(message, channelConfig?) {
    const channel = channelConfig?.channel ? channelConfig?.channel : this.config.channel
    // Convert markdown to Slack mrkdwn format, then convert Slack user ID mentions to Slack format.
    // Handles bare IDs (U123ABC) and @-prefixed IDs (@U123ABC), but not already-wrapped <@...> or non-ID @names.
    const text = markdownToMrkdwn(message.body)
      .replace(/(?<![<@\w])(U[A-Z0-9]{6,})\b/g, '<@$1>')
      .replace(/(?<!<)@(U[A-Z0-9]{6,})\b/g, '<@$1>')
    const slackWebClient = slackClientPool.getClient(this.config.botToken)

    let threadTs: string | undefined
    if (message.parentMessage) {
      const parent = await Message.findById(message.parentMessage).select('source').exec()
      threadTs = parent?.source?.id
    }

    // Prefer blocks rendered from a neutral render instruction (responseKind +
    // renderData); fall back to any pre-built blocks the message already carries.
    const renderedBlocks = renderResponseBlocks(message.responseKind, message.renderData)
    const blocks = (renderedBlocks ?? (message.blocks as (KnownBlock | Block)[])) as (KnownBlock | Block)[] | undefined

    const result = (await slackWebClient.chat.postMessage({
      channel,
      text,
      ...(threadTs && { thread_ts: threadTs }),
      // Include Block Kit blocks when provided. text is still required alongside blocks
      // as Slack uses it for notifications and accessibility fallback.
      ...(blocks?.length && { blocks })
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
    if (!this.config.botUserId) {
      const slackWebClient = slackClientPool.getClient(this.config.botToken)
      const authResult = await slackWebClient.auth.test()
      if (!authResult.ok || !authResult.user_id) {
        throw new Error(`Failed to look up Slack bot user ID: ${authResult.error}`)
      }
      this.config.botUserId = authResult.user_id
      logger.info(`Resolved Slack botUserId: ${this.config.botUserId}`)
    }
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
