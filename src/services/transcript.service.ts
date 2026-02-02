/* eslint-disable @typescript-eslint/no-unused-vars */
import httpStatus from 'http-status'
import { Conversation } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'
import websocketGateway from '../websockets/websocketGateway.js'

/**
 * Internal helper - updates transcript status without touching adapters
 * Use this when the status change is initiated by the system (e.g., webhook from adapter)
 */
const _updateTranscriptStatus = async (conversation, status: 'active' | 'paused' | 'stopped' | 'deleted'): Promise<void> => {
  if (!conversation.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
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
    await transcript.deleteTranscript(conversation)

    // Set transcript status to deleted after deletion
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

  return conversation
}

const transcriptService = {
  deleteTranscript,
  stopTranscript,
  // Export helper for system-initiated status changes (e.g., from webhooks)
  updateTranscriptStatus: _updateTranscriptStatus
}

export default transcriptService
