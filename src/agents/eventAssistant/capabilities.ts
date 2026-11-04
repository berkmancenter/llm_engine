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
    write: [{ type: 'ownConversation' as const }]
  }
}
