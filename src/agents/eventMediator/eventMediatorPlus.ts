import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { interventionLlmTemplateVars, USER_TEMPLATE } from '../helpers/interventionHandler.js'
import buildMediatorResponse, { getMediatorSystemPrompt } from './mediatorHandler.js'

export default verify({
  name: 'Event Mediator Plus',
  description:
    'Makes strategic interventions in shared chat and escalates significant themes to moderator, based on configurable intervention categories',
  priority: 85,
  maxTokens: 3000,
  // trigger on transcript updates, if any have occurred w/in the timer period
  // uses 67 seconds for now to prevent overlap with Engagement Agent (timer set to 60 seconds) - can be adjusted as needed
  defaultTriggers: {
    periodic: { timerPeriod: 67, conversationHistorySettings: { channels: ['transcript'] } }
  },
  agentConfig: {
    minInterval: 2, // 2 min between interventions
    personality: 'sarcastic-expert' // Use sarcastic-expert personality (set to null for no personality)
  },
  llmTemplateVars: interventionLlmTemplateVars,
  defaultLLMTemplates: {
    system: getMediatorSystemPrompt(true, 'sarcastic-expert'),
    user: USER_TEMPLATE
  },
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
    return buildMediatorResponse.call(
      this,
      this.conversation,
      conversationHistory,
      true // supportsModerator
    )
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
