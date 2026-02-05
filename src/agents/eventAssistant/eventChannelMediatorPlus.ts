import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  detectMediationOpportunity,
  createMediatorTemplates,
  mediatorLlmTemplateVars,
  type MediatorAnalysis,
  InterventionType
} from './mediatorHandler.js'
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
  name: 'Event Channel Mediator Plus',
  description: 'Monitors private and public channels to make strategic interventions in shared chat and escalate significant themes to moderator',
  priority: 85,
  maxTokens: 3000,
  defaultTriggers: {
    periodic: { timerPeriod: 60 }
  },
  agentConfig: {
    mediatorMinInterval: 60000, // 1 min between interventions
    minSignalsForConvergence: 2, // Minimum number of independent signals to surface a private theme
    personality: 'sarcastic-expert' // Use sarcastic-expert personality (set to null for no personality)
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
      translatedMsg.body = `💡 MODERATOR REPORT 💡
${msg.body.insights.map((insight) => `⚫ ${insight.value}`).join('\n')}`
      return translatedMsg
    }

    return translatedMsg
  },
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  // Get comprehensive conversation history across all channels
  defaultConversationHistorySettings: { 
    count: 100, // Large count for complete context
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
    // Get separate conversation histories for different channels
    // Shared chat (already provided as main conversationHistory)
    const sharedChatHistory = conversationHistory

    // Private messages - get all DMs
    const privateHistory = getConversationHistory(
      this.conversation.messages,
      { 
        count: 100, 
        directMessages: true,
        endTime: conversationHistory.end
      },
      null, // includeAgents
      this.conversation.channels.filter(c => c.direct).map(c => c.name) // directChannels
    )

    // Moderator context
    const moderatorHistory = getConversationHistory(
      this.conversation.messages,
      {
        count: 50,
        channels: ['moderator'],
        endTime: conversationHistory.end
      }
    )

    // Detect mediation opportunity
    const mediationAnalysis = await detectMediationOpportunity.call(
      this,
      sharedChatHistory,
      privateHistory,
      moderatorHistory
    )

    if (!mediationAnalysis) {
      logger.debug('Event Channel Mediator Plus: No intervention opportunity detected or rate limited')
      return [] // No opportunity detected, rate limited, or low confidence
    }

    logger.info(`Event Channel Mediator Plus: Detected ${mediationAnalysis.interventionType} opportunity - ${mediationAnalysis.detectedPattern}`)

    const responses: AgentResponse<string | Record<string, unknown>>[] = []

    // Post to shared chat if we have a message
    if (mediationAnalysis.sharedChatMessage) {
      responses.push({
        visible: true,
        message: mediationAnalysis.sharedChatMessage,
        channels: this.conversation.channels.filter((c) => c.name === 'chat'),
        context: `Intervention Type: ${mediationAnalysis.interventionType}\nReasoning: ${mediationAnalysis.reasoning}\nPattern: ${mediationAnalysis.detectedPattern || 'N/A'}`
      })
    }

    // Escalate to moderator if needed (structured JSON)
    if (mediationAnalysis.interventionType === InterventionType.MODERATOR_ESCALATION && mediationAnalysis.moderatorMessage) {
      const moderatorAlert = formatModeratorAlert(mediationAnalysis, conversationHistory)
      responses.push({
        visible: true,
        message: moderatorAlert,
        messageType: 'json',
        channels: this.conversation.channels.filter((c) => c.name === 'moderator'),
        context: `Intervention Type: ${mediationAnalysis.interventionType}\nReasoning: ${mediationAnalysis.reasoning}\nPattern: ${mediationAnalysis.detectedPattern || 'N/A'}`
      })
      
      logger.info(`Event Channel Mediator Plus: Escalated to moderator - ${mediationAnalysis.detectedPattern}`)
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
