import { AgentCapabilities } from '../../types/index.types.js'

/**
 * activeDuringPhases: 'participant' (its own conversationHistorySettings channel) is exactly
 * where pregame chat and /mod questions already land, unlike transcript-scoped agents — so its
 * normal 120s periodic respond() is meaningful pregame with no changes of its own, once
 * openConversationWindow actually starts it there. No onConversationEvent handler, so no read
 * grant is needed for event dispatch (handlesConversationEvents() gates that separately).
 */
export default function (): AgentCapabilities {
  return {
    read: [],
    write: [{ type: 'ownConversation' as const }],
    activeDuringPhases: ['preEvent']
  }
}
