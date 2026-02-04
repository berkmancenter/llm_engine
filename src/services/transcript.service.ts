/* eslint-disable @typescript-eslint/no-unused-vars */
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { Conversation } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import websocketGateway from '../websockets/websocketGateway.js'
import adapterService from './adapter.service.js'
import { formatTranscript } from '../agents/helpers/llmInputFormatters.js'

/**
 * Internal helper - updates transcript status without touching adapters
 * Use this when the status change is initiated by the system (e.g., webhook from adapter)
 */
const _updateTranscriptStatus = async (conversation, status: 'active' | 'paused' | 'stopped' | 'deleted'): Promise<void> => {
  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }
  if (conversation.transcript.status === status) {
    logger.debug(`Transcript already in status ${status} for conversation ${conversation._id}`)
    return
  }

  // eslint-disable-next-line no-param-reassign
  conversation.transcript.status = status
  await conversation.save()
  await websocketGateway.broadcastTranscriptStatusChange(conversation, status)
  logger.info(`Transcript ${status} for conversation ${conversation._id}`)
}

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

    await _updateTranscriptStatus(conversation, 'deleted')
  } catch (error) {
    logger.warn(`Failed to delete transcript for conversation ${conversation._id}: ${error.message}`)
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete transcript')
  }
}

const stopTranscript = async (conversationId) => {
  const conversation = await Conversation.findOne({ _id: conversationId }).populate(['topic', 'adapters'])
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }
  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }
  logger.debug(`Stop transcript recording for conversation: ${conversation._id}`)

  // Update transcript status and broadcast
  await _updateTranscriptStatus(conversation, 'stopped')
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
  if (!conversation.active) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot resume transcript for an inactive conversation')
  }
  logger.debug(`Resume transcript recording for conversation: ${conversation._id}`)

  // Resume recording on all adapters
  for (const adapter of conversation.adapters) {
    await adapterService.resumeRecording(adapter)
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
  stopTranscript,
  pauseTranscript,
  resumeTranscript,
  getPlainTextTranscript,
  // Export helper for system-initiated status changes (e.g., from webhooks)
  updateTranscriptStatus: _updateTranscriptStatus
}

export default transcriptService
