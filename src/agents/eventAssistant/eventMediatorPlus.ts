import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  detectInterventionOpportunity,
  createMediatorTemplates,
  mediatorLlmTemplateVars,
  type MediatorAnalysis
} from './mediatorHandler.js'
import {
  InterventionCategoriesConfig,
  InterventionType,
  defaultCategoriesConfig,
  shouldFetchPrivateMessages
} from './interventionCategories.js'
import logger from '../../config/logger.js'
import getConversationHistory from '../helpers/getConversationHistory.js'

function formatModeratorAlert(analysis: MediatorAnalysis, conversationHistory: ConversationHistory) {
  return {
    timestamp: {
      start: conversationHistory.start?.getTime() || Date.now(),
      end: conversationHistory.end?.getTime() || Date.now()
    },
    insights: [
      {
        value: analysis.moderatorMessage || `Pattern detected: ${analysis.detectedPattern} (${analysis.interventionType})`,
        type: 'insight'
      }
    ]
  }
}

export default verify({
  name: 'Event Mediator Plus',
  description:
    'Makes strategic interventions in shared chat and escalates significant themes to moderator, based on configurable intervention categories',
  priority: 85,
  maxTokens: 3000,
  // trigger on transcript updates, if any have occurred w/in the timer period
  defaultTriggers: {
    periodic: { timerPeriod: 60, conversationHistorySettings: { channels: ['transcript'] } }
  },
  agentConfig: {
    mediatorMinInterval: 60000, // 1 min between interventions
    personality: 'sarcastic-expert', // Use sarcastic-expert personality (set to null for no personality)
    // Default: all categories enabled with equal weight
    interventionCategories: defaultCategoriesConfig
  },
  llmTemplateVars: mediatorLlmTemplateVars,
  defaultLLMTemplates: createMediatorTemplates({ supportsModerator: true }),
  defaultLLMPlatform,
  defaultLLMModel,
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }

    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'

    // Handle moderator alerts (backChannelInsights format)
    if (msg.body.insights) {
      translatedMsg.body = `MODERATOR REPORT
${msg.body.insights.map((insight: { value: string }) => `* ${insight.value}`).join('\n')}`
      return translatedMsg
    }

    return translatedMsg
  },
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,

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
      logger.warn('Event Mediator Plus: No conversation available')
      return []
    }

    // Get category configuration from agentConfig
    const categoryConfig: InterventionCategoriesConfig = this.agentConfig?.interventionCategories || defaultCategoriesConfig

    // Shared chat
    const sharedChatHistory = getConversationHistory(this.conversation.messages, {
      count: 100,
      channels: ['chat'],
      endTime: conversationHistory.end
    })

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
      logger.debug('Event Mediator Plus: No intervention opportunity detected or rate limited')
      return [] // No opportunity detected, rate limited, or low confidence
    }

    logger.info(
      `Event Mediator Plus: Detected ${interventionAnalysis.interventionType} opportunity - ${interventionAnalysis.detectedPattern}`
    )

    const responses: AgentResponse<string | Record<string, unknown>>[] = []

    // Post to shared chat if we have a message
    if (interventionAnalysis.sharedChatMessage) {
      responses.push({
        visible: true,
        message: interventionAnalysis.sharedChatMessage,
        channels: this.conversation.channels.filter((c) => c.name === 'chat'),
        context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
          interventionAnalysis.reasoning
        }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
      })
    }

    // Escalate to moderator if needed (structured JSON)
    if (
      interventionAnalysis.interventionType === InterventionType.MODERATOR_ESCALATION &&
      interventionAnalysis.moderatorMessage
    ) {
      const moderatorAlert = formatModeratorAlert(interventionAnalysis, conversationHistory)
      responses.push({
        visible: true,
        message: moderatorAlert,
        messageType: 'json',
        channels: this.conversation.channels.filter((c) => c.name === 'moderator'),
        context: `Intervention Type: ${interventionAnalysis.interventionType}\nReasoning: ${
          interventionAnalysis.reasoning
        }\nPattern: ${interventionAnalysis.detectedPattern || 'N/A'}`
      })

      logger.info(`Event Mediator Plus: Escalated to moderator - ${interventionAnalysis.detectedPattern}`)
    }

    return responses
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
