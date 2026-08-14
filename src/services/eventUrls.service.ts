/*
 * The client-facing URLs for an event: where a participant joins, where a moderator
 * watches the back channel, and where the organizer edits the event.
 *
 * This is the only place the server assumes anything about the frontend's routing, so the
 * two view paths come from config (EVENT_PARTICIPANT_PATH, EVENT_MODERATOR_PATH) and a
 * client that routes differently overrides them without a code change. Everything after
 * the path is llm_engine's own API convention: `conversationId` plus a repeated
 * `channel=<name>,<passcode>` pair, the same shape message.controller.ts parses on the way
 * back in.
 *
 * Access is by channel passcode, not by account. A participant or moderator link works for
 * someone who has never signed in; the event page link does not, because it deep links
 * through the login screen into the admin view.
 */
import config from '../config/config.js'
import { CHAT_CHANNEL, MODERATOR_CHANNEL, TRANSCRIPT_CHANNEL } from '../conversations/eventAssistant.js'

/** Just enough of a Conversation to build its links; accepts a document or a plain object. */
export interface LinkableConversation {
  _id?: { toString(): string } | string
  id?: string
  conversationType?: string
  channels?: { name?: string; passcode?: string | null }[]
}

const conversationId = (conversation: LinkableConversation): string =>
  conversation.id ?? (typeof conversation._id === 'string' ? conversation._id : conversation._id?.toString() ?? '')

const passcodeFor = (conversation: LinkableConversation, channelName: string): string | undefined =>
  conversation.channels?.find((channel) => channel.name === channelName)?.passcode ?? undefined

/**
 * Query string naming the conversation and every requested channel the caller can actually
 * open. A channel with no passcode gets dropped, because its name on its own grants no
 * access and would only imply otherwise.
 */
const channelParams = (conversation: LinkableConversation, channelNames: string[]): URLSearchParams => {
  const params = new URLSearchParams({ conversationId: conversationId(conversation) })
  for (const name of channelNames) {
    const passcode = passcodeFor(conversation, name)
    if (passcode) params.append('channel', `${name},${passcode}`)
  }
  return params
}

/**
 * Where a participant joins the event. Safe to share with everyone invited to the meeting:
 * it carries no moderator passcode, so it cannot reach the back channel.
 * @param {LinkableConversation} conversation
 * @returns {string}
 */
const participantUrl = (conversation: LinkableConversation): string =>
  `${config.appHost}${config.eventUrlPaths.participant}?${channelParams(conversation, [TRANSCRIPT_CHANNEL, CHAT_CHANNEL])}`

/**
 * Where the moderator watches the back channel. Undefined when the conversation has no
 * moderator passcode, which happens when moderator support is off: the URL would render
 * without the token that grants access, and a link that silently fails is worse than none.
 * @param {LinkableConversation} conversation
 * @returns {string | undefined}
 */
const moderatorUrl = (conversation: LinkableConversation): string | undefined => {
  if (!passcodeFor(conversation, MODERATOR_CHANNEL)) return undefined
  return `${config.appHost}${config.eventUrlPaths.moderator}?${channelParams(conversation, [
    MODERATOR_CHANNEL,
    TRANSCRIPT_CHANNEL
  ])}`
}

/**
 * Where the organizer confirms and edits the event. Unlike the other two, this one requires
 * an account: it routes through the login screen and lands on the admin view afterwards.
 * @param {LinkableConversation} conversation
 * @returns {string}
 */
const eventPageUrl = (conversation: LinkableConversation): string =>
  `${config.appHost}/login?redirectTo=/admin/${conversation.conversationType}/view/${conversationId(conversation)}`

const eventUrls = { participantUrl, moderatorUrl, eventPageUrl }
export default eventUrls
