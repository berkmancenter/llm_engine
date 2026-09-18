import { AgentCapabilities } from '../../types/index.types.js'

/**
 * The Concept Cartographer maps the event it is attached to and nothing else.
 *
 * `ownConversation` on both sides, deliberately narrower than the Vibes Analyst's
 * `allPublicTopics` or the Number Cruncher's `allTopics`: those two post one card about an
 * event into their own admin channel, while this one reads a private event's full transcript
 * and chat and writes a durable artifact from it. There is no version of that job it should
 * be doing for an event nobody attached it to, so it is enabled per conversation and scoped
 * to the conversation it belongs to.
 */
export default function (): AgentCapabilities {
  return {
    read: [{ type: 'ownConversation' as const }],
    write: [{ type: 'ownConversation' as const }]
  }
}
