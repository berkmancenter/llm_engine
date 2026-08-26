import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { Conversation } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import adapterService from './adapter.service.js'
import conversationService from './conversation.service/index.js'
import { formatTranscript } from '../agents/helpers/llmInputFormatters.js'
import { roleRights } from '../config/roles.js'
import { MODERATOR_CHANNEL } from '../conversations/eventAssistant.js'
import { ChannelCredential } from '../types/index.types.js'

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
  if (roleRights.get(user?.role)?.includes(right)) return

  /* No moderator channel, or one deliberately configured without a passcode, leaves nothing
     to check against, so the controls fall back to admins only. Say that plainly: a caller
     who reads this as a rejected passcode will keep retrying a link that cannot ever work. */
  await conversation.populate('channels')
  const moderatorChannel = conversation.channels?.find((channel) => channel.name === MODERATOR_CHANNEL)
  if (!moderatorChannel?.passcode) {
    throw new ApiError(
      httpStatus.FORBIDDEN,
      'This conversation has no moderator passcode, so only an administrator can control its transcript'
    )
  }

  const presented = channels.find((channel) => channel.name === MODERATOR_CHANNEL)
  if (!presented || presented.passcode !== moderatorChannel.passcode) {
    throw new ApiError(httpStatus.FORBIDDEN, `Incorrect or missing passcode for channel: ${MODERATOR_CHANNEL}`)
  }
}

const deleteTranscript = async (conversationId, user, channels: ChannelCredential[] = []) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
    .populate(['topic', 'agents'])
    .select('name owner topic agents channels transcript')
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
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
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
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
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }

  await authorizeTranscriptControl(conversation, user, 'resumeTranscript', channels)

  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }

  logger.debug(`Resume transcript recording for conversation: ${conversation._id}`)

  // If conversation is not active, start it first
  // startConversation already handles adapter.start() which deploys the bot
  if (!conversation.active) {
    await conversationService.startConversation(conversation, user)
    // Don't call resumeRecording - the bot was just deployed by startConversation
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
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
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
