import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'

const SETUP_INTENT_PATTERNS = [/\bsetup\b/i, /\bcreate event\b/i, /\bcreate an? event\b/i, /\bnew event\b/i]

export default verify({
  name: 'Event Setup',
  description: 'Collects event details from organizers via Slack and creates a new nextspace event',
  priority: 100,
  maxTokens: 4000,
  defaultTriggers: {
    perMessage: { channels: ['setup'] }
  },
  agentConfig: {
    botName: 'Event Setup Bot'
  },
  llmTemplateVars: {},
  defaultLLMTemplates: {},
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 50, channels: ['setup'] },

  async evaluate(userMessage) {
    const body = userMessage?.body ?? ''
    const hasBotMention = body.toLowerCase().includes(`@${this.agentConfig.botName}`.toLowerCase())
    const hasSetupIntent = SETUP_INTENT_PATTERNS.some((pattern) => pattern.test(body))

    if (hasBotMention || hasSetupIntent) {
      return {
        userMessage,
        action: AgentMessageActions.CONTRIBUTE,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    return {
      userMessage,
      action: AgentMessageActions.OK,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(_conversationHistory: ConversationHistory, userMessage) {
    const setupChannel = this.conversation.channels.find((channel) => channel.name === 'setup')
    const parentMessageId = userMessage.parentMessage

    return [
      {
        visible: true,
        message: 'Event setup coming soon',
        messageType: 'text',
        channels: setupChannel ? [setupChannel] : [],
        parent: parentMessageId
      }
    ]
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  formatTraceInput(_conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0]?.message
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      conversationHistory,
      channels: userMessage?.channels,
      topic: responses[0]?.topic
    }
  }
})
