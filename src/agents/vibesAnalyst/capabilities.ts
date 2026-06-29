import { AgentCapabilities } from '../../types/index.types.js'

/**
 * The vibes analyst reacts to every public event that ends, so it reads all
 * public topics, and it only ever posts back into its own admin conversation.
 */
export default function (): AgentCapabilities {
  return {
    read: [{ type: 'allPublicTopics' as const }],
    write: [{ type: 'ownConversation' as const }]
  }
}
