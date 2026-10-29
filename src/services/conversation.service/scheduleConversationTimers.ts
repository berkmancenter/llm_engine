import config from '../../config/config.js'
import logger from '../../config/logger.js'
import schedule from '../../jobs/schedule.js'

/* Not folded into conversation.service/index.ts (which calls these) or lifecycle.ts:
   organizerConfirmation.service.ts needs to reschedule the same way when a relayed invite is
   confirmed late, and importing conversation.service/index.ts for it would close a circular
   import — that module imports updateTranscriptStatus from lifecycle.ts, which (via
   jobs/define.js's handlers barrel) transitively reaches organizerConfirmation.service.ts's own
   job handler, landing back on a still-initializing lifecycle.ts. Depending only on
   jobs/schedule.js, config.js and logger.js here, all leaf with no path back, avoids that without
   duplicating the logic in both places. This is a workaround for that one cycle, not a template —
   don't reach for a new file like this for every future job type. */

/**
 * (Re)schedules a conversation's auto-start job for autoStartLeadTimeMs before its scheduledTime,
 * cancelling any existing one first.
 */
export async function scheduleConversationAutoStart(conversation) {
  await schedule.cancelAutoStartConversation(conversation._id)
  const scheduledAt = new Date(conversation.scheduledTime.getTime() - config.conversation.autoStartLeadTimeMs)
  await schedule.autoStartConversation(scheduledAt, { conversationId: conversation._id })
  logger.info(`Scheduled auto-start for conversation ${conversation._id} at ${scheduledAt}`)
}

/**
 * (Re)schedules a conversation's preEvent window job for preEventMinutes before its
 * scheduledTime, cancelling any existing one first. No-op if preEventMinutes isn't set.
 */
export async function scheduleConversationPreEventWindow(conversation) {
  await schedule.cancelOpenConversationWindow(conversation._id, 'preEvent')
  if (typeof conversation.preEventMinutes !== 'number') return
  const scheduledAt = new Date(conversation.scheduledTime.getTime() - conversation.preEventMinutes * 60 * 1000)
  await schedule.triggerOpenConversationWindow(scheduledAt, { conversationId: conversation._id, phase: 'preEvent' })
  logger.info(`Scheduled pre-event window for conversation ${conversation._id} at ${scheduledAt}`)
}

/**
 * Both of the above, for call sites that always schedule them together (creation, and an
 * organizer confirming a relayed invite). Call the two separately where they have different
 * triggering conditions, as conversation.service/index.ts's update path does.
 */
export async function rescheduleConversationTimers(conversation) {
  await scheduleConversationAutoStart(conversation)
  await scheduleConversationPreEventWindow(conversation)
}
