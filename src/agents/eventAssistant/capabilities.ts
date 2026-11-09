import { AgentCapabilities } from '../../types/index.types.js'

/**
 * Event Assistant only ever acts on events about the conversation it's attached to — pregame
 * content triggered by the preEvent window opening and its countdown ticking, plus a recap once
 * the conversation actually starts, nothing conversation-type-agnostic or cross-event. Scoped to
 * exactly the event types onConversationEvent handles today: an unrestricted ownConversation
 * grant would still let agentDispatcher schedule (and trace) a job for every other event type
 * too, each one immediately no-op'd by the handler's own early return — wasted work for nothing.
 * Widen this list as onConversationEvent grows more cases.
 */
export default function (): AgentCapabilities {
  return {
    read: [
      {
        type: 'ownConversation' as const,
        events: [
          'conversationWindowCountdown' as const,
          'conversationWindowOpened' as const,
          'conversationStarted' as const
        ]
      }
    ],
    write: [{ type: 'ownConversation' as const }],
    /* Needed for DM reachability during pregame (answering questions asked via DM before the
       event starts) — previously inferred from having a perMessage trigger, now explicit. This
       also schedules the periodic/proactive check-in trigger early, which respond() itself
       guards against running until isPreEventWindowOpen is false (see respond()'s periodic
       branch) — opting in here without that guard would have it proactively "checking in" on
       participants before the event has even begun. */
    activeDuringPhases: ['preEvent']
  }
}
