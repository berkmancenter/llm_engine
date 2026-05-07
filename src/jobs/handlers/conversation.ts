import logger from '../../config/logger.js'
import { Conversation } from '../../models/index.js'
import { doStartConversation, doStopConversation } from '../../services/conversation.service/lifecycle.js'

const autoStartConversation = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`Auto-start: conversation ${conversationId} not found`)
      return
    }
    if (conversation.active) {
      logger.debug(`Auto-start: conversation ${conversationId} already active, skipping`)
      return
    }
    await conversation.populate(['topic', 'agents', 'adapters'])
    await doStartConversation(conversation)
  } catch (err) {
    logger.error(`Auto-start failed for conversation ${conversationId}`, err)
  }
}

const autoStopConversation = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`Auto-stop: conversation ${conversationId} not found`)
      return
    }
    if (!conversation.active) {
      logger.debug(`Auto-stop: conversation ${conversationId} already inactive, skipping`)
      return
    }
    await conversation.populate(['topic', 'agents', 'adapters'])
    await doStopConversation(conversation)
  } catch (err) {
    logger.error(`Auto-stop failed for conversation ${conversationId}`, err)
  }
}

const conversationHandlers = { autoStartConversation, autoStopConversation }
export default conversationHandlers
