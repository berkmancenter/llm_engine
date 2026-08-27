import { AgentCapabilities } from '../../types/index.types.js'

export default function (agentConfig: Record<string, unknown>): AgentCapabilities {
  const topicIds: string[] = (agentConfig?.topicIds as string[]) ?? []
  const read = topicIds.length > 0
    ? topicIds.map((id) => ({ type: 'topic' as const, id }))
    : [{ type: 'allPublicTopics' as const }]
  return {
    read: [...read, { type: 'ownConversation' as const }],
    write: [{ type: 'ownConversation' as const }]
  }
}
