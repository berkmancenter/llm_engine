import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  detectConfusion,
  confusionDetectionLLMTemplates,
  confusionDetectionLlmTemplateVars,
  type ConfusionDetectionResult
} from './confusionDetectionHandler.js'

function formatModeratorConfusionAlert(analysis: ConfusionDetectionResult, conversationHistory: ConversationHistory) {
  const plural = analysis.affectedUsers > 1 ? 'participants are' : 'participant is'

  return {
    timestamp: {
      start: conversationHistory.start.getTime(),
      end: conversationHistory.end.getTime()
    },
    insights: [
      {
        value: `Confusion detected: ${analysis.affectedUsers} ${plural} confused about ${analysis.confusionTopic}`,
        type: 'insight'
      }
    ]
  }
}

export default verify({
  name: 'Event Confusion Monitor Plus',
  description: 'Monitors chat for participant confusion and provides proactive assistance with moderator escalation',
  priority: 90,
  maxTokens: 2000,
  defaultTriggers: {
    periodic: { timerPeriod: 60 }
  },
  agentConfig: {
    confusionDetectionInterval: 300000 // 5 min between interventions
  },
  llmTemplateVars: confusionDetectionLlmTemplateVars,
  defaultLLMTemplates: confusionDetectionLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }

    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'

    // Handle confusion alerts (backChannelInsights format)
    if (msg.body.insights) {
      translatedMsg.body = `💡 MODERATOR REPORT 💡
${msg.body.insights.map((insight) => `⚫ ${insight.value}`).join('\n')}`
      return translatedMsg
    }

    return translatedMsg
  },
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
      return []
    }

    const responses: AgentResponse<string | Record<string, unknown>>[] = []

    // Direct response if can resolve
    if (confusionAnalysis.canResolveDirectly && confusionAnalysis.suggestedResponse) {
      responses.push({
        visible: true,
        message: confusionAnalysis.suggestedResponse,
        channels: this.conversation.channels.filter((c) => c.name === 'chat'),
        context: confusionAnalysis.context
      })
    }

    // Escalate to moderator if needed (structured JSON)
    if (confusionAnalysis.requiresEscalation) {
      const moderatorAlert = formatModeratorConfusionAlert(confusionAnalysis, conversationHistory)
      responses.push({
        visible: true,
        message: moderatorAlert,
        messageType: 'json',
        channels: this.conversation.channels.filter((c) => c.name === 'moderator'),
        context: confusionAnalysis.context
      })
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
