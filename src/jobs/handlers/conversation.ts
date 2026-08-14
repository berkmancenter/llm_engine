import logger from '../../config/logger.js'
import { Conversation, Message } from '../../models/index.js'
import {
  doConversationEndingSoon,
  doStartConversation,
  doStopConversation
} from '../../services/conversation.service/lifecycle.js'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000

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

const conversationEndingSoon = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`Conversation ending soon: conversation ${conversationId} not found`)
      return
    }
    if (!conversation.active) {
      logger.debug(`Conversation ending soon: conversation ${conversationId} already inactive, skipping`)
      return
    }
    await doConversationEndingSoon(conversation)
  } catch (err) {
    logger.error(`Conversation ending soon failed for conversation ${conversationId}`, err)
  }
}

const autoStopConversation = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`autoStop: conversation ${conversationId} not found`)
      return
    }

    const now = Date.now()
    const lastTranscriptMessage = await Message.findOne({
      conversation: conversationId,
      channels: { $in: ['transcript'] }
    })
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean()

    const shouldStop = !lastTranscriptMessage || now - (lastTranscriptMessage.createdAt?.getTime() ?? 0) >= IDLE_TIMEOUT_MS

    if (shouldStop) {
      logger.info(
        `autoStop: stopping conversation ${conversationId} — ${
          lastTranscriptMessage ? `idle for ${IDLE_TIMEOUT_MS / 60000} minutes` : 'no transcript activity in grace period'
        }`
      )
      await conversation.populate(['topic', 'agents', 'adapters'])
      await doStopConversation(conversation)
    }
  } catch (err) {
    logger.error(`Auto stop check failed for conversation ${conversationId}`, err)
  }
}

const conversationHandlers = { autoStartConversation, autoStopConversation, conversationEndingSoon }
export default conversationHandlers
