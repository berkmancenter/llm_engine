import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { USER_TEMPLATE, interventionLlmTemplateVars } from '../helpers/interventionHandler.js'

import buildMediatorResponse, { getMediatorSystemPrompt } from './mediatorHandler.js'

export default verify({
  name: 'Event Mediator',
  description:
    'Makes strategic interventions in shared chat based on configurable intervention categories: collective consciousness, engagement, and facilitation',
  priority: 85,
  maxTokens: 3000,
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
    system: getMediatorSystemPrompt(false, 'sarcastic-expert'),
    user: USER_TEMPLATE
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,

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
    return buildMediatorResponse.call(
      this,
      this.conversation,
      conversationHistory,
      false // supportsModerator
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
