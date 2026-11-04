import logger from '../../config/logger.js'
import schedule from '../../jobs/schedule.js'
import adapterTypes from '../../adapters/index.js'
import Adapter from '../../models/adapter.model.js'

/* Not folded into conversation.service/index.ts (which calls these) or lifecycle.ts:
   organizerConfirmation.service.ts needs to reschedule the same way when a relayed invite is
   confirmed late, and importing conversation.service/index.ts for it would close a circular
   import — that module imports updateTranscriptStatus from lifecycle.ts, which (via
   jobs/define.js's handlers barrel) transitively reaches organizerConfirmation.service.ts's own
   job handler, landing back on a still-initializing lifecycle.ts. Depending only on
   jobs/schedule.js, adapters/index.js, config.js and logger.js here, all leaf with no path back,
   avoids that without duplicating the logic in both places. This is a workaround for that one
   cycle, not a template — don't reach for a new file like this for every future job type. */

/**
 * (Re)schedules a conversation's auto-start job for its scheduledTime, cancelling any existing
 * one first.
 */
export async function scheduleConversationAutoStart(conversation) {
  await schedule.cancelAutoStartConversation(conversation._id)
  await schedule.autoStartConversation(conversation.scheduledTime, { conversationId: conversation._id })
  logger.info(`Scheduled auto-start for conversation ${conversation._id} at ${conversation.scheduledTime}`)
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
 * (Re)schedules an early-start job for each of this conversation's adapters whose type declares
 * it needs lead time before the conversation officially starts (an adapter type opts in with its
 * own `preStartLeadMs` — see zoom.ts — rather than this file assuming which types need it; most
 * adapter types don't and are left alone). No-op for a type the conversation doesn't use, or that
 * declares no preStartLeadMs at all. See preStartAdapter for what the job itself does.
 */
export async function scheduleAdapterPreStarts(conversation) {
  const typesNeedingPreStart = Object.entries(adapterTypes as Record<string, { preStartLeadMs?: number }>).filter(
    ([, type]) => typeof type.preStartLeadMs === 'number'
  )
  await Promise.all(
    typesNeedingPreStart.map(async ([adapterType, type]) => {
      await schedule.cancelAdapterPreStart(conversation._id, adapterType)
      const hasAdapter = await Adapter.exists({ conversation: conversation._id, type: adapterType })
      if (!hasAdapter) return
      const scheduledAt = new Date(conversation.scheduledTime.getTime() - type.preStartLeadMs!)
      await schedule.adapterPreStart(scheduledAt, { conversationId: conversation._id, adapterType })
      logger.info(`Scheduled ${adapterType} adapter pre-start for conversation ${conversation._id} at ${scheduledAt}`)
    })
  )
}

/**
 * All of the above, for call sites that always schedule them together (creation, and an
 * organizer confirming a relayed invite). Call them separately where they have different
 * triggering conditions, as conversation.service/index.ts's update path does.
 */
export async function rescheduleConversationTimers(conversation) {
  await scheduleConversationAutoStart(conversation)
  await scheduleConversationPreEventWindow(conversation)
  await scheduleAdapterPreStarts(conversation)
}
