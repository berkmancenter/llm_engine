/* eslint-disable @typescript-eslint/no-unused-vars */
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { Conversation } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import adapterService from './adapter.service.js'
import conversationService from './conversation.service/index.js'
import { formatTranscript } from '../agents/helpers/llmInputFormatters.js'

const deleteTranscript = async (conversationId, user) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
    .populate(['topic', 'agents'])
    .select('name owner topic agents transcript')
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }
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

const pauseTranscript = async (conversationId, user) => {
  const conversation = await Conversation.findOne({ _id: conversationId }).populate(['topic', 'adapters'])
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }

  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }
  logger.debug(`Pause transcript recording for conversation: ${conversation._id}`)

  // Pause recording on all adapters
  for (const adapter of conversation.adapters) {
    await adapterService.pauseRecording(adapter)
  }
}

const resumeTranscript = async (conversationId, user) => {
  const conversation = await Conversation.findOne({ _id: conversationId }).populate(['topic', 'adapters'])
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }

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

const getPlainTextTranscript = async (conversationId, timezone = 'UTC') => {
  let conversation = conversationId
  if (typeof conversationId === 'string' || conversationId instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversationId })
  }

  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }

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
