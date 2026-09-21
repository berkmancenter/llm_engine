import logger from '../../config/logger.js'
import { Conversation, Message } from '../../models/index.js'
import {
  doConversationEndingSoon,
  doStartConversation,
  doStopConversation
} from '../../services/conversation.service/lifecycle.js'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MIN_TRANSCRIPT_MESSAGES_TO_STOP = 10
const NEVER_STARTED_GRACE_MS = 30 * 60 * 1000

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
    if (!conversation.active) {
      logger.info(`autoStop: conversation ${conversationId} already inactive, skipping`)
      return
    }

    const now = Date.now()
    const [lastTranscriptMessage, transcriptCount] = await Promise.all([
      Message.findOne({ conversation: conversationId, channels: { $in: ['transcript'] } })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean(),
      Message.countDocuments({ conversation: conversationId, channels: { $in: ['transcript'] } })
    ])

    const runningTimeMs = now - (conversation.startTime?.getTime() ?? now)
    const lastTranscriptMs = lastTranscriptMessage?.createdAt?.getTime() ?? 0
    const startTimeMs = conversation.startTime?.getTime() ?? 0
    const lastActivityMs = lastTranscriptMessage ? now - Math.max(lastTranscriptMs, startTimeMs) : Infinity

    if (lastActivityMs < IDLE_TIMEOUT_MS) {
      logger.debug(
        `autoStop: conversation ${conversationId} is active — last transcript ${lastActivityMs === Infinity ? 'never' : `${Math.round(lastActivityMs / 60000)} min ago`}, ${transcriptCount} message(s)`
      )
      return
    }

    // Never-started guard: few messages and within the grace period — give it more time
    if (transcriptCount < MIN_TRANSCRIPT_MESSAGES_TO_STOP && runningTimeMs < NEVER_STARTED_GRACE_MS) {
      logger.info(
        `autoStop: skipping stop for conversation ${conversationId} — only ${transcriptCount} transcript message(s), running for ${Math.round(
          runningTimeMs / 60000
        )} minutes`
      )
      return
    }

    const idleMinutes = lastActivityMs === Infinity ? 'never started' : `${Math.round(lastActivityMs / 60000)} min`
    logger.info(
      `autoStop: stopping conversation ${conversationId} — idle for ${idleMinutes}, ${transcriptCount} transcript message(s)`
    )
    await conversation.populate(['topic', 'agents', 'adapters'])
    await doStopConversation(conversation)
  } catch (err) {
    logger.error(`Auto stop check failed for conversation ${conversationId}`, err)
  }
}

const conversationHandlers = { autoStartConversation, autoStopConversation, conversationEndingSoon }
export default conversationHandlers
