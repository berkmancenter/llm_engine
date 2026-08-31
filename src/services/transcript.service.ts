import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { Conversation } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import adapterService from './adapter.service.js'
import conversationService from './conversation.service/index.js'
import { doStartConversation } from './conversation.service/lifecycle.js'
import { formatTranscript } from '../agents/helpers/llmInputFormatters.js'
import { roleRights } from '../config/roles.js'
import { MODERATOR_CHANNEL } from '../conversations/eventAssistant.js'
import { ChannelCredential } from '../types/index.types.js'

/* One wording for every refusal a caller without the right can trigger: wrong passcode, no
   passcode, an event with no moderator channel, and an id that matches no conversation. The
   route only asks for `getConversation`, which every participant holds, so a message that
   varied by case would let any signed-in account probe for conversation ids and for how an
   event is configured. It still names what the caller needs, which is all a real moderator
   with a stale link can act on anyway. */
const TRANSCRIPT_REFUSAL =
  "You need this conversation's moderator passcode, or an administrator account, to control its transcript"

const holdsTranscriptRight = (user, right: string) => !!roleRights.get(user?.role)?.includes(right)

/*
 * Guards one of the four transcript controls: download, pause, resume, delete.
 *
 * There are two ways in. An organizer's role already holds the matching right
 * (`pauseTranscript` and friends), so they pass with nothing on the request. That is how an
 * organizer reaches these controls at all. Everyone else has to present the moderator
 * channel's passcode, because a moderator reaches the event through a link carrying that
 * passcode and the throwaway account it creates is an ordinary participant.
 *
 * It has to be the moderator channel and no other. A participant's own link carries the
 * transcript channel's passcode, so accepting that one would hand the recording controls to
 * everyone who was invited to the meeting.
 *
 * @param {object} conversation Conversation document, not a plain object: the passcode
 *   branch populates its channels.
 * @param {object} user The authenticated caller.
 * @param {string} right The transcript right this control maps to in the roles config.
 * @param {ChannelCredential[]} channels Channel credentials read off the request's query string.
 */
const authorizeTranscriptControl = async (conversation, user, right: string, channels: ChannelCredential[] = []) => {
  if (holdsTranscriptRight(user, right)) return

  await conversation.populate('channels')
  const moderatorChannel = conversation.channels?.find((channel) => channel.name === MODERATOR_CHANNEL)
  const presented = channels.find((channel) => channel.name === MODERATOR_CHANNEL)
  if (!moderatorChannel?.passcode || presented?.passcode !== moderatorChannel.passcode) {
    throw new ApiError(httpStatus.FORBIDDEN, TRANSCRIPT_REFUSAL)
  }
}

/* An id that matches nothing looks the same as a conversation the caller may not touch, so
   probing cannot confirm a conversation exists. A caller who already holds the right is
   allowed to know, and still gets the 404. */
const missingConversationError = (conversationId, user, right: string) =>
  holdsTranscriptRight(user, right)
    ? new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
    : new ApiError(httpStatus.FORBIDDEN, TRANSCRIPT_REFUSAL)

const deleteTranscript = async (conversationId, user, channels: ChannelCredential[] = []) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
    .populate(['topic', 'agents'])
    .select('name owner topic agents channels transcript')
    .exec()
  if (!conversation) {
    throw missingConversationError(conversationId, user, 'deleteTranscript')
  }

  await authorizeTranscriptControl(conversation, user, 'deleteTranscript', channels)

  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }

  // Prevent deleting an active transcript - must pause first
  if (conversation.transcript.status === 'active') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete an active transcript. Please pause the transcript first.')
  }

  logger.debug(`Delete transcript for conversation: ${conversation._id}`)

  try {
    await transcript.clearTranscript(conversation)

    await conversationService.updateTranscriptStatus(conversation, 'deleted')
  } catch (error) {
    logger.warn(`Failed to delete transcript for conversation ${conversation._id}: ${error.message}`)
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete transcript')
  }
}

const pauseTranscript = async (conversationId, user, channels: ChannelCredential[] = []) => {
  const conversation = await Conversation.findOne({ _id: conversationId }).populate(['topic', 'adapters'])
  if (!conversation) {
    throw missingConversationError(conversationId, user, 'pauseTranscript')
  }

  await authorizeTranscriptControl(conversation, user, 'pauseTranscript', channels)

  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }
  logger.debug(`Pause transcript recording for conversation: ${conversation._id}`)

  // Pause recording on all adapters
  for (const adapter of conversation.adapters) {
    await adapterService.pauseRecording(adapter)
  }
}

const resumeTranscript = async (conversationId, user, channels: ChannelCredential[] = []) => {
  const conversation = await Conversation.findOne({ _id: conversationId }).populate(['topic', 'adapters'])
  if (!conversation) {
    throw missingConversationError(conversationId, user, 'resumeTranscript')
  }

  await authorizeTranscriptControl(conversation, user, 'resumeTranscript', channels)

  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }

  logger.debug(`Resume transcript recording for conversation: ${conversation._id}`)

  // If conversation is not active, start it first
  // Starting the conversation already handles adapter.start() which deploys the bot
  if (!conversation.active) {
    /* Deliberately not conversationService.startConversation: that one re-checks ownership,
       which would reject a moderator whose passcode already cleared the check above. This is
       the same unguarded start the scheduled auto-start uses, and it needs `agents` populated. */
    await conversation.populate('agents')
    await doStartConversation(conversation)
    // Don't call resumeRecording - the bot was just deployed by the start above
  } else {
    // Conversation is active, resume recording on all adapters
    // This will redeploy the bot if needed (e.g., if it left the call)
    for (const adapter of conversation.adapters) {
      await adapterService.resumeRecording(adapter)
    }
  }
}

const getPlainTextTranscript = async (conversationId, user, channels: ChannelCredential[] = [], timezone = 'UTC') => {
  let conversation = conversationId
  if (typeof conversationId === 'string' || conversationId instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversationId })
  }

  if (!conversation) {
    throw missingConversationError(conversationId, user, 'getTranscript')
  }

  await authorizeTranscriptControl(conversation, user, 'getTranscript', channels)

  await conversation.populate('messages')
  const transcriptMessages = conversation.messages
    .filter((m) => m.channels.includes('transcript'))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return formatTranscript(transcriptMessages, timezone)
}

const transcriptService = {
  deleteTranscript,
  pauseTranscript,
  resumeTranscript,
  getPlainTextTranscript
}

export default transcriptService
