import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import verify from '../helpers/verify.js'

import logger from '../../config/logger.js'

import {
  backChannelLLMTemplates,
  backChannelLLMTemplateVars,
  processParticipantMessages
} from './backChannelInsightsGenerator.js'

export default verify({
  name: 'Back Channel Insights Agent',
  description: 'An agent to analyze participant comments and generate insights for the moderator',
  priority: 5,
  maxTokens: 2000,
  defaultTriggers: { periodic: { timerPeriod: 120 } },
  agentConfig: {
    maxInsights: 3,
    reportingThreshold: 2,
    transcriptTimeWindow: 15,
    introMessage:
      "Hi! I'm the LLM Backchannel. You can DM me with questions and comments, and I'll use these to post insights from you and your fellow audience members to the main chat. I won't identify you, and I won't read messages from the main chat. Please note that I am not currently able to respond to your questions or comments directly. To kick off, what are you hoping to get from today's event?"
  },
  llmTemplateVars: backChannelLLMTemplateVars,
  defaultLLMTemplates: backChannelLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  ragCollectionName: undefined,
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }
    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'
    translatedMsg.body = `💡 MODERATOR REPORT 💡
${msg.body.insights.map((insight) => `⚫ ${insight.value}`).join('\n')}`
    return translatedMsg
  },
  parseInput: (msg) => {
    if (msg.bodyType === 'json') {
      return msg
    }
    const translatedMsg = { ...msg }
    translatedMsg.bodyType = 'json'
    translatedMsg.body = { text: msg.body }
    return translatedMsg
  },
  defaultConversationHistorySettings: { timeWindow: 120, channels: ['participant'] },
  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory) {
    // Don't respond if all messages are presets
    const textMessages = conversationHistory.messages.filter((message) => !(message.body as Record<string, unknown>).preset)
    if (textMessages.length === 0) {
      logger.debug('No messages to process')
      return []
    }
    return processParticipantMessages.call(this, textMessages, conversationHistory.start, conversationHistory.end)
  },
  async start() {
    return true
  },
  async stop() {
    return true
  },
  async introduce(channel) {
    if (channel.direct) {
      return [
        {
          message: this.agentConfig.introMessage,
          channels: [channel],
          visible: true
        }
      ]
    }
    return []
  }
})
