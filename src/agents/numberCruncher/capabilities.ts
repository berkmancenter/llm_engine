import { AgentCapabilities } from '../../types/index.types.js'

/**
 * Number Cruncher only posts into its own admin conversation.
 * It does not read other conversations.
 */
export default function (): AgentCapabilities {
  return {
    read: [],
    write: [{ type: 'ownConversation' as const }]
  }
}
