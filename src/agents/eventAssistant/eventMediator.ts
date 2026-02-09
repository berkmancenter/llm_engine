import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  detectInterventionOpportunity,
  createMediatorTemplates,
  mediatorLlmTemplateVars
} from './mediatorHandler.js'
import {
  InterventionCategoriesConfig,
  defaultCategoriesConfig,
  shouldFetchPrivateMessages
} from './interventionCategories.js'
import logger from '../../config/logger.js'
import getConversationHistory from '../helpers/getConversationHistory.js'

export default verify({
  name: 'Event Mediator',
  description:
    'Makes strategic interventions in shared chat based on configurable intervention categories: collective consciousness, engagement, and facilitation',
  priority: 85,
  maxTokens: 3000,
  defaultTriggers: {
    periodic: { timerPeriod: 60 }
  },
  agentConfig: {
    mediatorMinInterval: 60000, // 1 min between interventions
    personality: 'sarcastic-expert', // Use sarcastic-expert personality (set to null for no personality)
    // Default: all categories enabled with equal weight
    interventionCategories: defaultCategoriesConfig
  },
  llmTemplateVars: mediatorLlmTemplateVars,
  defaultLLMTemplates: createMediatorTemplates({ supportsModerator: false }),
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  // Get comprehensive conversation history across all channels
  defaultConversationHistorySettings: {
    count: 100,
    channels: ['chat']
  },

  async initialize() {
    return true
  },

  async evaluate(userMessage) {
    // Periodic trigger only
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory) {
    // Ensure conversation is available
    if (!this.conversation) {
      logger.warn('Event Mediator: No conversation available')
      return []
    }

    // Get category configuration from agentConfig
    const categoryConfig: InterventionCategoriesConfig =
      this.agentConfig?.interventionCategories || defaultCategoriesConfig

    // Shared chat (already provided as main conversationHistory)
    const sharedChatHistory = conversationHistory

    // Only fetch private messages if needed based on category config
    let privateHistory: ConversationHistory | null = null
    if (shouldFetchPrivateMessages(categoryConfig)) {
      privateHistory = getConversationHistory(
        this.conversation.messages,
        {
          count: 100,
          directMessages: true,
          endTime: conversationHistory.end
        },
        null, // includeAgents
        this.conversation.channels.filter((c) => c.direct).map((c) => c.name) // directChannels
      )
    }

    // Moderator context
    const moderatorHistory = getConversationHistory(this.conversation.messages, {
      count: 50,
      channels: ['moderator'],
      endTime: conversationHistory.end
    })

    // Detect intervention opportunity with category config
    const interventionAnalysis = await detectInterventionOpportunity.call(
      this,
      sharedChatHistory,
      privateHistory,
      moderatorHistory,
      categoryConfig
    )

    if (!interventionAnalysis) {
      logger.debug('Event Mediator: No intervention opportunity detected or rate limited')
      return [] // No opportunity detected, rate limited, or low confidence
    }

    logger.info(
      `Event Mediator: Detected ${interventionAnalysis.interventionType} opportunity - ${interventionAnalysis.detectedPattern}`
    )

    // Post to shared chat if we have a message
    if (interventionAnalysis.sharedChatMessage) {
      return [
        {
          visible: true,
          message: interventionAnalysis.sharedChatMessage,
          channels: this.conversation.channels.filter((c) => c.name === 'chat'),
          context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
            interventionAnalysis.reasoning
          }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
        }
      ]
    }

    return [] // No message to post
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
    // No introduction - silent monitoring
    return []
  }
})
