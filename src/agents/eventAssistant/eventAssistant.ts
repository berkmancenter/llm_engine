import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'

export default verify({
  name: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true, channels: ['chat'] }
  },
  agentConfig: {
    introMessage:
      "Hi! I'm the LLM Event Assistant. You can ask me questions about the event content like “what did I just miss,” or, “what was that acronym?” None of your messages to me will be surfaced to the moderator or the rest of the audience, but please note that a pseudonymized message transcript will be visible to our eng team. Please share your feedback on the tool at brk.mn/feedback!",
    chatIntroMessage:
      'Welcome to the chat! This is a space to chat with other event participants. You can also ask me questions with an @Event Assistant mention. Just remember that everyone can see what you ask me here. Use the Event Assistant tab if you want to talk privately. Have fun!'
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  defaultConversationHistorySettings: { count: 100, directMessages: true, channels: ['chat'] },

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    if (userMessage?.channels?.includes('chat') && !userMessage?.body.includes('@Event Assistant')) {
      // regular chat message, no need to process
      return {
        userMessage,
        action: AgentMessageActions.OK,
        userContributionVisible: true,
        suggestion: undefined
      }
    }
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage) {
    const modifiedMessage = { ...userMessage }
    if (userMessage?.channels?.includes('chat')) {
      // trim the '@Event Assistant' from the message body so it's just a regular question
      modifiedMessage.body = modifiedMessage.body
        .trim()
        .replace(/@Event Assistant/gi, '')
        .trim()
    }
    const agentResponse = await answerQuestion.call(this, modifiedMessage, conversationHistory)
    return [agentResponse]
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
    if (channel.name === 'chat') {
      return [
        {
          message: this.agentConfig.chatIntroMessage,
          channels: [channel],
          visible: true
        }
      ]
    }
    return []
  },

  formatTraceInput(conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0].message
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      context: responses[0].context,
      conversationHistory,
      channels: userMessage?.channels,
      promptType: responses[0]?.promptType
    }
  }
})
