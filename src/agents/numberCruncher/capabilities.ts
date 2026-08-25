import { AgentCapabilities } from '../../types/index.types.js'

/**
 * Number Cruncher reads every event that ends, public or private, so it can price
 * liveEvent spend even for private topics (real money was spent regardless of the
 * topic's privacy). `allTopics`, not `allPublicTopics` — deliberately broader than
 * every other agent (vibesAnalyst, communityAssistant), which only ever touch public
 * topics. See agent.ts's onConversationEvent for how private topics are then
 * handled: postEvent never applies to them (no other agent runs post-event work on
 * a private topic), and the Slack card redacts the event name.
 */
export default function (): AgentCapabilities {
  return {
    read: [{ type: 'allTopics' as const }],
    write: [{ type: 'ownConversation' as const }]
  }
}
