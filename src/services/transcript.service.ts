import httpStatus from 'http-status'
import { Conversation } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import logger from '../config/logger.js'
import transcript from '../agents/helpers/transcript.js'

const deleteTranscript = async (conversationId, user) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
    .populate(['topic', 'agents'])
    .select('name owner topic agents')
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }
  if (user._id.toString() !== conversation.owner.toString() && user._id.toString() !== conversation.topic.owner.toString()) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can delete transcript')
  }
  logger.debug(`Delete transcript for conversation: ${conversation._id}`)

  try {
    await transcript.deleteTranscript(conversation)
  } catch (error) {
    logger.warn(`Failed to delete transcript for conversation ${conversation._id}: ${error.message}`)
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Failed to delete transcript')
  }
}

const transcriptService = {
  deleteTranscript
}

export default transcriptService
