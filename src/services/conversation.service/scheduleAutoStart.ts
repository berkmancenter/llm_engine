import config from '../../config/config.js'
import logger from '../../config/logger.js'
import schedule from '../../jobs/schedule.js'

/**
 * (Re)schedules a conversation's auto-start job for autoStartLeadTimeMs before its scheduledTime,
 * cancelling any existing one first.
 *
 * Its own tiny leaf module, not folded into conversation.service/index.ts (which calls this) or
 * lifecycle.ts: organizerConfirmation.service.ts needs to reschedule the same way when a
 * relayed invite is confirmed late, and importing conversation.service/index.ts for it would
 * close a circular import — that module imports updateTranscriptStatus from lifecycle.ts, which
 * (via jobs/define.js's handlers barrel) transitively reaches organizerConfirmation.service.ts's
 * own job handler, landing back on a still-initializing lifecycle.ts. Depending only on
 * jobs/schedule.js and config.js here, both leaf dependencies with no path back, avoids that
 * without duplicating the logic in both places.
 */
const scheduleConversationAutoStart = async (conversation) => {
  await schedule.cancelAutoStartConversation(conversation._id)
  const scheduledAt = new Date(conversation.scheduledTime.getTime() - config.conversation.autoStartLeadTimeMs)
  await schedule.autoStartConversation(scheduledAt, { conversationId: conversation._id })
  logger.info(`Scheduled auto-start for conversation ${conversation._id} at ${scheduledAt}`)
}

export default scheduleConversationAutoStart
