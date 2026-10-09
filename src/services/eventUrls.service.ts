/*
 * The client-facing URLs for an event. View paths come from config, so a frontend that routes
 * differently moves them without a code change. Participant, presentation, and moderator links
 * open by channel passcode without sign-in; the event page link goes through the login screen.
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

const PARTICIPANT_CHANNELS = [TRANSCRIPT_CHANNEL, CHAT_CHANNEL]

/**
 * Where a participant joins the event. Safe to share with everyone invited to the meeting:
 * it carries no moderator passcode, so it cannot reach the back channel.
 * @param {LinkableConversation} conversation
 * @returns {string}
 */
const participantUrl = (conversation: LinkableConversation): string =>
  `${config.appHost}${config.eventUrlPaths.participant}?${channelParams(conversation, PARTICIPANT_CHANNELS)}`

/**
 * The participant view enlarged for a projector or shared screen. Uses the participant's
 * channels, so it carries no moderator passcode.
 * @param {LinkableConversation} conversation
 * @returns {string}
 */
const presentationUrl = (conversation: LinkableConversation): string =>
  `${config.appHost}${config.eventUrlPaths.presentation}?${channelParams(conversation, PARTICIPANT_CHANNELS)}`

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
 * Where the organizer confirms and edits the event. Unlike the others, this one requires
 * an account: it routes through the login screen and lands on the admin view afterwards.
 * @param {LinkableConversation} conversation
 * @returns {string}
 */
const eventPageUrl = (conversation: LinkableConversation): string =>
  `${config.appHost}/login?redirectTo=/admin/${conversation.conversationType}/view/${conversationId(conversation)}`

const eventUrls = { participantUrl, presentationUrl, moderatorUrl, eventPageUrl }
export default eventUrls
