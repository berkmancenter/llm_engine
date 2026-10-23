import { findMessages } from '../../utils/messageVisibility.js'
import { AgentCapabilities, IMessage } from '../../types/index.types.js'

/**
 * The vibes analyst reacts to every public event that ends, so it reads all
 * public topics, and it only ever posts back into its own admin conversation.
 */
export default function (): AgentCapabilities {
  return {
    // Scoped to conversationStopped: this agent's own onConversationEvent handler only ever
    // acts on that event type anyway, so an unrestricted topic-wide grant would still let
    // agentDispatcher schedule (and trace) a job for every participantJoined system-wide, each
    // one immediately no-op'd by the handler's own early return — wasted work for nothing.
    // Unaffected: summon.ts's on-demand recap re-check, a non-event read with no event type to
    // pass — see grantAppliesToEvent's handling of an omitted eventType in access.ts.
    read: [{ type: 'allPublicTopics' as const, events: ['conversationStopped'] }],
    write: [{ type: 'ownConversation' as const }]
  }
}

/**
 * Channels the Vibes Analyst may read message text from. An allowlist, so any
 * channel not named here is excluded by default, the same fail-closed stance as
 * the topic privacy gate above.
 *
 * These cover the shared event content an attendee or moderator already saw: the
 * `transcript`, the public `chat`, and the `moderator` backchannel (the recap
 * posts to the VA's admin channel, where moderator visibility already exists).
 * One-to-one `direct` DM channels are left out; they carry generated names, so a
 * private DM never matches the allowlist.
 */
export const VA_READABLE_CHANNELS = ['transcript', 'chat', 'moderator'] as const

/**
 * Loads the messages the Vibes Analyst may read for content analysis: every
 * message in an allowlisted channel, oldest first. The one guarded entry point
 * for VA content reads, so the channel boundary lives in a single auditable place.
 *
 * Agent messages are included so callers can count agent activity (for example,
 * how many times a configured bot was invoked); filter by `fromAgent` as needed.
 */
export async function loadReadableMessages(conversationId): Promise<IMessage[]> {
  /* 'model' audience: the analyst's annotation passes send this text to an LLM and the recap stores the
     result, so hidden chat (flagged, hidden author, reply under hidden) is left out here. */
  return findMessages(
    conversationId,
    'model',
    { channels: { $in: [...VA_READABLE_CHANNELS] } },
    { select: 'body bodyType pseudonym fromAgent createdAt channels visible owner', sort: { createdAt: 1 } }
  )
}
