import { AgentCapabilities } from '../../types/index.types.js'

export default function (agentConfig: Record<string, unknown>): AgentCapabilities {
  const topicIds: string[] = (agentConfig?.topicIds as string[]) ?? []
  return {
    read: topicIds.map((id) => ({ type: 'topic' as const, id })),
    write: [{ type: 'ownConversation' as const }]
  }
}
