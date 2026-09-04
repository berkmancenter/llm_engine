import { ChatPostMessageResponse } from '@slack/web-api'
import type { KnownBlock, Block } from '@slack/types'
import logger from '../../config/logger.js'
import slackClientPool from './client.js'
import { AdapterMessage } from '../../types/adapter.types.js'
import Message from '../../models/message.model.js'
import ConversationMembership from '../../models/conversationMembership.model.js'
import renderResponseBlocks from './blocks/index.js'

function normalizeBotMention(text: string, botUserId: string, botName: string): string {
  if (!botUserId || !botName) return text
  // Slack HTML-encodes angle brackets in event payloads: &lt;@USER_ID&gt;
  const escapedId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // eslint-disable-next-line security/detect-non-literal-regexp
  return text.replace(new RegExp(`(?:&lt;|<)@${escapedId}(?:&gt;|>)`, 'g'), `@${botName}`)
}

async function syncSlackExternalIds() {
  const conversationId = this.conversation._id

  const hasMemberships = await ConversationMembership.exists({ conversation: conversationId })
  if (!hasMemberships) {
    logger.debug(`Slack externalIds sync: no memberships for conversation ${conversationId}, skipping`)
    return
  }

  logger.info(`Slack externalIds sync: starting for conversation ${conversationId}`)
  const slackWebClient = slackClientPool.getClient(this.config.botToken)
  let cursor: string | undefined
  let pageCount = 0
  let totalUpdated = 0
  do {
    const result = await slackWebClient.users.list({ limit: 200, cursor })
    if (!result.ok || !result.members) {
      logger.warn(`Slack externalIds sync: users.list failed for conversation ${conversationId}`)
      break
    }
    pageCount++

    const emailToSlackId: Record<string, string> = {}
    for (const member of result.members) {
      const email = member.profile?.email
      if (email && member.id && !member.deleted && !member.is_bot) {
        emailToSlackId[email.toLowerCase()] = member.id
      }
    }

    const emails = Object.keys(emailToSlackId)
    if (emails.length > 0) {
      const memberships = await ConversationMembership.find({
        conversation: conversationId,
        email: { $in: emails }
      })
        .select('_id email externalIds')
        .lean()

      const updates = memberships
        .filter((m) => emailToSlackId[m.email] && m.externalIds?.slack !== emailToSlackId[m.email])
        .map((m) => ({
          updateOne: {
            filter: { _id: m._id },
            update: { $set: { 'externalIds.slack': emailToSlackId[m.email] } }
          }
        }))

      if (updates.length > 0) {
        await ConversationMembership.bulkWrite(updates)
        totalUpdated += updates.length
        logger.debug(`Slack externalIds sync: page ${pageCount} updated ${updates.length} memberships`)
      }
    }

    cursor = result.response_metadata?.next_cursor || undefined
  } while (cursor)
  logger.info(
    `Slack externalIds sync: done for conversation ${conversationId} — ${totalUpdated} memberships updated across ${pageCount} page(s)`
  )
}

async function findThreadParent(conversationId, threadTs) {
  const parent = await Message.findOne({ conversation: conversationId, 'source.id': threadTs }).select('_id').exec()
  return parent?._id ?? null
}

/**
 * Replaces one person's App Home page with the given blocks.
 *
 * Published per viewer rather than once for everyone, which is how Slack's Home tab
 * works: each person gets their own copy of the view.
 *
 * @throws when Slack refuses the publish, so the caller can log which page failed
 */
export async function publishHomeView(botToken: string, userId: string, blocks: KnownBlock[]): Promise<void> {
  const slackWebClient = slackClientPool.getClient(botToken)
  const result = await slackWebClient.views.publish({ user_id: userId, view: { type: 'home', blocks } })
  if (!result.ok) {
    throw new Error(`Slack home view failed to publish: ${result.error}`)
  }
}

async function receiveGroupChatMessage(event) {
  const msg: AdapterMessage<string> = {
    message: normalizeBotMention(event.text, this.config.botUserId, this.config.botName),
    /* Store Slack identity in source so it survives DB persistence.
       The user field is only used for auth lookup and is not saved. */
    source: { type: 'slack', id: event.ts, userId: event.user, teamId: event.team, channelId: event.channel },
    channels: this.chatChannels,
    user: { username: `${event.team}-${event.user}`, pseudonym: event.user, externalId: event.user }
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
    user: {
      username: `${event.team}-${event.user}`,
      pseudonym: event.user,
      externalId: event.user,
      dmConfig: { channel: event.channel }
    }
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
  /* Maps conversation property keys to the adapter config keys they should write.
     The conversation service reads this at update time to push changed properties
     to Slack adapter documents without needing to know which keys Slack cares about. */
  configSyncMap: {
    slackBotUserId: 'botUserId',
    botName: 'botName',
    slackBotToken: 'botToken',
    slackSigningSecret: 'signingSecret',
    slackChannel: 'channel',
    slackWorkspace: 'workspace',
    slackAppKey: 'appKey'
  },
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
    // Sync workspace members to ConversationMembership.externalIds.slack so agents
    // can @mention people by Slack user ID without per-message users.info calls.
    // Runs best-effort: a missing users:read scope or Slack API error logs and continues
    // rather than failing the whole adapter start.
    try {
      await syncSlackExternalIds.call(this)
    } catch (err) {
      logger.warn(`Slack externalIds sync failed for conversation ${this.conversation._id}: ${err.message}`)
    }
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
    if (this.dmChannels?.length > 0) {
      // config.appKey scopes the conflict check to the same app bucket. When no appKey is set,
      // explicitly exclude keyed adapters so a keyed and unkeyed app can each have DM routing.
      const query: Record<string, unknown> = {
        type: 'slack',
        'config.workspace': this.config.workspace,
        'config.appKey': this.config.appKey ?? { $exists: false },
        dmChannels: { $exists: true, $not: { $size: 0 } },
        _id: { $ne: this._id }
      }
      // Dynamic import breaks the circular dependency:
      // adapter.model → defaultAdapterTypes → slack/index → adapter.model.
      // Ideally this cross-adapter uniqueness check would live in adapter.service.ts
      // rather than here, with the adapter type declaring the constraint declaratively
      // (e.g. a dmUniqueKeys() hook) and the service executing the DB query. That would
      // keep adapter types free of model imports entirely.
      const { default: Adapter } = await import('../../models/adapter.model.js')
      const conflict = await Adapter.findOne(query)
      if (conflict) {
        throw new Error(
          `Another Slack adapter for this workspace${
            this.config.appKey ? `/appKey` : ''
          } already handles DMs. Only one adapter per app can have dmChannels.`
        )
      }
    }
  },
  async participantJoined(participant) {
    const adapterUser = {
      username: `${participant.team}-${participant.user}`,
      pseudonym: participant.user,
      externalId: participant.user
    }

    const hasMemberships = await ConversationMembership.exists({ conversation: this.conversation._id })
    if (!hasMemberships) {
      logger.debug(`participantJoined: no memberships for conversation ${this.conversation._id}, skipping users.info`)
      return adapterUser
    }

    // If the initial sync (or a prior join) already mapped this Slack user ID to a membership
    // record, skip the users.info API call entirely — avoids rate-limit pressure during bulk
    // workspace invites where most members were already synced on start().
    const alreadySynced = await ConversationMembership.exists({
      conversation: this.conversation._id,
      'externalIds.slack': participant.user
    })
    if (alreadySynced) {
      logger.debug(`participantJoined: ${participant.user} already synced, skipping users.info`)
      return adapterUser
    }

    logger.debug(`participantJoined: ${participant.user} not yet synced, calling users.info`)
    const slackWebClient = slackClientPool.getClient(this.config.botToken)
    const result = await slackWebClient.users.info({ user: participant.user })
    if (!result.ok || !result.user) {
      logger.warn(`participantJoined: users.info failed for ${participant.user}, proceeding without email`)
      return adapterUser
    }

    const email = result.user.profile?.email
    if (email) {
      // Write the Slack user ID to the membership record so getOrCreateUser can find
      // the right account by externalId rather than creating a Slack-keyed duplicate.
      await ConversationMembership.updateOne(
        { conversation: this.conversation._id, email },
        { $set: { 'externalIds.slack': participant.user } }
      )
      logger.info(`participantJoined: wrote externalIds.slack for ${participant.user} (${email})`)
    } else {
      logger.debug(`participantJoined: ${participant.user} has no email in Slack profile, skipping membership update`)
    }

    return adapterUser
  },
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async participantLeft(participant) {
    // no-op
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
    return ['type', 'config.channel', 'config.workspace', 'config.appKey']
  }
}
