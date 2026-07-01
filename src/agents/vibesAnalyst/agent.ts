import verify from '../helpers/verify.js'
import {
  classificationLLMModel,
  classificationLLMPlatform,
  defaultLLMModel,
  defaultLLMPlatform,
  getModelChat
} from '../helpers/getModelChat.js'
import Conversation from '../../models/conversation.model.js'
import access from '../../auth/access.js'
import { AgentMessageActions, LlmPlatforms } from '../../types/index.types.js'
import analyticsSources from '../../services/analyticsSources/index.js'
import logger from '../../config/logger.js'
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'
import buildVibesSummary from './buildSummary.js'
import eventMetricsSnapshotService from '../../services/eventMetricsSnapshot.service.js'
import handleSummon from './summon.js'
import { HELLO_MESSAGE } from './prompt.js'
import defaultTriggers from './triggers.js'

/* Resolves the faster secondary model the mechanical passes run on (summon parsing, spike and
   reception annotation). It reads the per-agent override first, then the shared classification
   config, so the model is never hardcoded here and matches the pattern other agents use. */
function resolveFastLlm(agentConfig?: { classificationPlatform?: string; classificationModel?: string }) {
  const platform = agentConfig?.classificationPlatform || classificationLLMPlatform
  const model = agentConfig?.classificationModel || classificationLLMModel
  return getModelChat(platform as LlmPlatforms, model)
}

export default verify({
  name: 'Vibes Analyst',
  description: 'Posts engagement metrics to its admin channel when a public event ends.',
  priority: 100,
  maxTokens: undefined,
  defaultTriggers,
  llmTemplateVars: undefined,
  defaultLLMTemplates: undefined,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,

  async start() {
    return true
  },

  async stop() {
    return true
  },

  // Posts the install greeting into the channel it is introduced to.
  async introduce(channel) {
    return [
      {
        visible: true,
        message: HELLO_MESSAGE,
        messageType: 'text' as const,
        channels: [channel]
      }
    ]
  },

  // Summon path: people can @mention the analyst in its channel to recap a past event.
  // Mirror the chatbot's gate. Normalize the mention so respond sees a clean address;
  // the real decision to act, and which event, happens in respond.
  async evaluate(userMessage) {
    const words = userMessage?.body?.trim().split(/\s+/) ?? []
    const modifiedMessage = matchBotMention(words, this.agentConfig.botName)
      ? { ...userMessage, body: normalizeBotMention(userMessage.body, this.agentConfig.botName) }
      : userMessage
    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  // Answers a summon, but only when the message is actually addressed to the analyst.
  // Hands off to the summon handler, which resolves the event and posts (or declines)
  // its recap. The conversation history is unused: a summon names its own event.
  async respond(_conversationHistory, userMessage) {
    if (!userMessage) return []
    const llm = await this.getLLM()
    if (!(await checkBotIntent(llm, this.agentConfig.botName, userMessage))) return []
    const fastLlm = await resolveFastLlm(this.agentConfig)
    return handleSummon(this, userMessage, llm, fastLlm)
  },

  // Fires when a public event stops (the dispatcher matches VA's allPublicTopics
  // read grant). Posts one engagement-metrics card into VA's own admin channel.
  async onConversationEvent(evt) {
    if (evt.type !== 'conversationStopped') return []

    const conversation = await Conversation.findById(evt.conversationId).populate('topic')
    if (!conversation) return []

    // Re-check read access here even though the dispatcher already gated it, so
    // least privilege stays explicit at the read site. Fail closed: anything but
    // an explicit `private: false` counts as private, so an unpopulated or deleted
    // topic is never read as public.
    const topic = conversation.topic as { _id?: { toString(): string }; private?: boolean } | undefined
    access.assertCanRead(this, {
      type: 'conversation',
      id: evt.conversationId,
      topicId: topic?._id?.toString(),
      topicIsPrivate: topic?.private !== false
    })

    /* Pull external tracked-session snapshots (e.g. Matomo) now, from inside this
       dispatched job rather than on the event-stop request. Matomo may not have
       archived the just-ended event's visits yet, so the fetch retries patiently;
       doing that here keeps the stop fast and never blocks on a cold archive. The
       fetch self-checks its config and the event's refs, no-ops when unset, and
       swallows provider errors, so a failure just leaves the card without tracked
       sessions rather than aborting the recap. */
    try {
      await analyticsSources.fetchAndStoreSnapshot(conversation)
    } catch (error: unknown) {
      logger.error(
        `Vibes Analyst could not capture analytics snapshot for ${conversation._id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    // Build the verified engagement card from the shared pipeline (compute metrics,
    // annotate from the allowed channels, curate, then fact-check). The snapshot fetch
    // above is the only event-stop-specific step; the rest is reused by the summon path.
    const llm = await getModelChat(defaultLLMPlatform as LlmPlatforms, defaultLLMModel)
    const fastLlm = await resolveFastLlm(this.agentConfig)
    const { renderData, metrics } = await buildVibesSummary(conversation, llm, fastLlm)

    /* Persist this event's metrics as a per-event snapshot so every metric can be trended
       over time, not just the few the baseline re-derives. Best-effort, like the analytics
       fetch above: a snapshot write must never block the recap card from posting. The
       snapshot stores counts only and drops the verbatim spike and reception quotes. */
    try {
      await eventMetricsSnapshotService.persistSnapshot(conversation, metrics)
    } catch (error: unknown) {
      logger.error(
        `Vibes Analyst could not persist metrics snapshot for ${conversation._id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

    return [
      {
        visible: true,
        // Fallback text for adapters that do not render the card (e.g. zoom).
        message: `Vibes summary for *${conversation.name}*`,
        messageType: 'text' as const,
        responseKind: 'curatedVibesSummary' as const,
        renderData,
        channels: this.conversation.channels
      }
    ]
  }
})
