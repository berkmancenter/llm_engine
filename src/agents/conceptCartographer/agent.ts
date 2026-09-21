import verify from '../helpers/verify.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import access from '../../auth/access.js'
import conceptGraphService from '../../services/conceptGraph/index.js'
import { AgentMessageActions } from '../../types/index.types.js'

const HELLO_MESSAGE =
  "Concept Cartographer online. When this event ends I'll map the concepts it turned on, and how the discussion related them, into a concept graph artifact."

/*
 * Draws the concept map for an event once it finishes.
 *
 * Deliberately thin: everything that matters — loading the record, the Chatham House checks,
 * assembly, the write — lives in services/conceptGraph, because the same work is reachable
 * from POST /v1/artifacts/generate and a second copy here would drift from it. This file is
 * the automatic trigger and nothing else.
 *
 * It contributes no messages. Every other post-event agent posts a card; this one's output
 * is the artifact, and announcing it in the chat of an event that has already ended would
 * reach nobody. The empty return is the point, not an omission.
 */
export default verify({
  name: 'Concept Cartographer',
  description:
    'After an event ends, maps the concepts it turned on and how the discussion related them into a concept graph artifact. Unattributed, under the Chatham House Rule.',
  priority: 100,
  maxTokens: undefined,
  defaultTriggers: undefined,
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

  async evaluate(userMessage = null) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond() {
    return []
  },

  async onConversationEvent(evt) {
    if (evt.type !== 'conversationStopped') return []
    if (evt.conversationId !== this.conversation?._id?.toString()) return []

    /* Re-checked at the read site even though the dispatcher already gated it, the same
       way the Vibes Analyst does — least privilege stays visible where the read happens. */
    access.assertCanRead(this, { type: 'conversation', id: evt.conversationId })

    try {
      const result = await conceptGraphService.generateConceptGraph(evt.conversationId, this)
      if (!result) {
        logger.info(`conceptCartographer: nothing to map for conversation ${evt.conversationId}`)
        return []
      }
      logger.info(
        `conceptCartographer: wrote version ${result.version.versionNumber} of artifact ${result.artifact!._id} ` +
          `for conversation ${evt.conversationId}`
      )

      /* Then fold this event into the series' own graph. A topic accumulates: each event
         leaves one more version behind, so the sequence of versions records how the
         series' understanding developed. The extraction is handed over rather than redone,
         so the second graph costs a merge and an alias pass, not a second read of the
         transcript. */
      const topicId = this.conversation?.topic?._id?.toString() ?? this.conversation?.topic?.toString()
      if (topicId) {
        const refined = await conceptGraphService.refineTopicGraph(topicId, this, {
          results: result.results,
          texts: result.texts,
          knownIdentities: result.knownIdentities,
          conversationId: evt.conversationId
        })
        if (refined) {
          logger.info(`conceptCartographer: refined topic ${topicId} graph to version ${refined.version.versionNumber}`)
        }
      }
    } catch (error) {
      /* The event is already over and the artifact is regenerable from
         POST /v1/artifacts/generate, so a failure here is logged rather than retried —
         a retry would re-run the whole extraction and its cost for a job nobody is waiting on. */
      logger.error(`conceptCartographer: failed to map conversation ${evt.conversationId}`, error)
    }

    return []
  }
})
