import { AgentCapabilities } from '../../types/index.types.js'

/**
 * Number Cruncher reads every public event that ends (so it can price it from
 * LangSmith traces), and only ever posts back into its own admin conversation.
 */
export default function (): AgentCapabilities {
  return {
    read: [{ type: 'allPublicTopics' as const }],
    write: [{ type: 'ownConversation' as const }]
  }
}
