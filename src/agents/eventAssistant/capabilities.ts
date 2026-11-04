import { AgentCapabilities } from '../../types/index.types.js'

/**
 * Event Assistant only ever acts on events about the conversation it's attached to — posting
 * pregame content once the preEvent window's countdown starts ticking, nothing
 * conversation-type-agnostic or cross-event. Scoped to conversationWindowCountdown specifically,
 * the only event its onConversationEvent handles today: an unrestricted ownConversation grant
 * would still let agentDispatcher schedule (and trace) a job for every other event type too,
 * each one immediately no-op'd by the handler's own early return — wasted work for nothing.
 * Widen this list as onConversationEvent grows more cases.
 */
export default function (): AgentCapabilities {
  return {
    read: [{ type: 'ownConversation' as const, events: ['conversationWindowCountdown' as const] }],
    write: [{ type: 'ownConversation' as const }]
  }
}
