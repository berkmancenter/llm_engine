import { IConversation } from '../../types/index.types.js'

/**
 * Whether this conversation's preEvent window is currently open: preEventMinutes configured,
 * past the computed open time, and the conversation hasn't started, ended, or stayed a draft.
 * Closes at startTime rather than the advertised scheduledTime, since a conversation can still
 * be started ahead of scheduledTime via the admin/owner "start now" endpoint or a moderator
 * resuming a transcript — both call doStartConversation directly with no time check of their
 * own — and once that's happened the window is over regardless of what scheduledTime says. The
 * normal auto-start path now fires exactly at scheduledTime, so for it this is equivalent to
 * checking scheduledTime itself. A draft conversation never auto-starts at all, so its window is
 * never considered open either — otherwise a draft would get its agents turned on during what
 * would be its pregame window with nothing left to ever turn them back off (see
 * jobs/handlers/conversation.ts's openConversationWindow).
 *
 * Its own leaf module rather than living in lifecycle.ts itself, for the same reason as this
 * directory's scheduleConversationTimers.ts: lifecycle.ts imports agentService, which (via the
 * Agent model) imports the agent type registry, and (via the models/index.js barrel) the adapter
 * type registry too — an agent or adapter type importing this back from lifecycle.ts would close
 * a real circular import. Depending only on the IConversation type (erased at compile time) here
 * avoids that.
 */
export default function isPreEventWindowOpen(
  conversation: Pick<IConversation, 'scheduledTime' | 'preEventMinutes' | 'startTime' | 'endTime' | 'draft'>
): boolean {
  if (conversation.startTime || conversation.endTime || conversation.draft) return false
  // preEventMinutes <= 0 is treated the same as unconfigured, matching openConversationWindow's
  // own falsy check (jobs/handlers/conversation.ts) — otherwise this could read the window as
  // open for the few seconds around scheduledTime where that job never ran to activate anything.
  if (typeof conversation.preEventMinutes !== 'number' || conversation.preEventMinutes <= 0) return false
  if (!conversation.scheduledTime) return false
  const opensAt = new Date(conversation.scheduledTime).getTime() - conversation.preEventMinutes * 60 * 1000
  return Date.now() >= opensAt
}
