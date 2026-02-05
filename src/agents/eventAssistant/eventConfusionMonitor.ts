import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  detectConfusion,
  confusionDetectionLLMTemplates,
  confusionDetectionLlmTemplateVars
} from './confusionDetectionHandler.js'
import logger from '../../config/logger.js'

export default verify({
  name: 'Event Confusion Monitor',
  description: 'Monitors chat for participant confusion and provides proactive assistance',
  priority: 90,
  maxTokens: 2000,
  defaultTriggers: {
    periodic: { timerPeriod: 60 }
  },
  agentConfig: {
    confusionDetectionInterval: 300000 // 5 min between interventions=
  },
  llmTemplateVars: confusionDetectionLlmTemplateVars,
  defaultLLMTemplates: confusionDetectionLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  defaultConversationHistorySettings: { count: 15, channels: ['chat'] },

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
    const confusionAnalysis = await detectConfusion.call(this, conversationHistory)

    if (!confusionAnalysis) {
      logger.debug('Confusion detection: No confusion analysis returned')
      return [] // No confusion detected or rate limited
    }

    // Generate direct response if possible
    if (confusionAnalysis.canResolveDirectly && confusionAnalysis.suggestedResponse) {
      return [
        {
          visible: true,
          message: confusionAnalysis.suggestedResponse,
          channels: this.conversation.channels.filter((c) => c.name === 'chat'),
          context: confusionAnalysis.context
        }
      ]
    }

    return [] // Confusion detected but can't/shouldn't respond
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
