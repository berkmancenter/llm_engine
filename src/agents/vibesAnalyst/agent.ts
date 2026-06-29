import verify from '../helpers/verify.js'
import { defaultLLMModel, defaultLLMPlatform, getModelChat } from '../helpers/getModelChat.js'
import Conversation from '../../models/conversation.model.js'
import access from '../../auth/access.js'
import { LlmPlatforms } from '../../types/index.types.js'
import conversationAnalyticsService from '../../services/conversationAnalytics.service.js'
import analyticsSources from '../../services/analyticsSources/index.js'
import logger from '../../config/logger.js'
import curateVibesCard from './curate.js'
import verifyCuratedCard from './verifyCuration.js'
import { HELLO_MESSAGE } from './prompt.js'
import defaultTriggers from './triggers.js'

/* How long the event ran, in whole minutes, for the card footer. Returns 0 when
   either timestamp is missing so the card still renders. */
function eventDurationMinutes(startTime?: Date, endTime?: Date): number {
  if (!startTime || !endTime) return 0
  const elapsedMs = endTime.getTime() - startTime.getTime()
  return Math.max(0, Math.round(elapsedMs / 60000))
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

  // Fires when a public event stops (the dispatcher matches VA's allPublicTopics
  // read grant). Posts one engagement-metrics card into VA's own admin channel.
  async onConversationEvent(evt) {
    if (evt.type !== 'conversationStopped') return []

    const conversation = await Conversation.findById(evt.conversationId).populate('topic')
    if (!conversation) return []

    // Re-check read access at the read site even though the dispatcher gated it,
    // so least privilege stays explicit. Private topics are not readable.
    const topic = conversation.topic as { _id?: { toString(): string }; private?: boolean } | undefined
    access.assertCanRead(this, {
      type: 'conversation',
      id: evt.conversationId,
      topicId: topic?._id?.toString(),
      topicIsPrivate: topic?.private === true
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

    // Build the evidence bundle from Mongo (participation, activity, history) plus
    // the stored tracked-session snapshots, then let the analyst model write the card
    // and a second model fact-check it before anything is posted.
    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
    const llm = await getModelChat(defaultLLMPlatform as LlmPlatforms, defaultLLMModel)
    const eventMeta = {
      eventName: conversation.name,
      durationMinutes: eventDurationMinutes(conversation.startTime, conversation.endTime)
    }
    const draftCard = await curateVibesCard(metrics, eventMeta, llm)
    const renderData = await verifyCuratedCard(draftCard, metrics, llm)

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
