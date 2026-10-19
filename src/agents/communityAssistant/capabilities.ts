import { AgentCapabilities } from '../../types/index.types.js'

export default function (agentConfig: Record<string, unknown>): AgentCapabilities {
  const topicIds: string[] = (agentConfig?.topicIds as string[]) ?? []
  // Topic-wide reach is for announcing event_ended to the whole community — it must NOT
  // also pick up participant_joined, or this agent gets dispatched (and posts/LLM-calls)
  // for every participant joining every public event, not just its own conversation.
  const read =
    topicIds.length > 0
      ? topicIds.map((id) => ({ type: 'topic' as const, id, events: ['conversationStopped' as const] }))
      : [{ type: 'allPublicTopics' as const, events: ['conversationStopped' as const] }]
  return {
    read: [...read, { type: 'ownConversation' as const }],
    write: [{ type: 'ownConversation' as const }]
  }
}
