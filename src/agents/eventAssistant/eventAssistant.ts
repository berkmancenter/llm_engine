import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'

export default verify({
  name: 'Event Assistant',
  description: 'An assistant to answer questions about an event',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { directMessages: true }
  },
  agentConfig: {
    introMessage:
      "Hi! I'm the LLM Event Assistant. You can ask me questions about the event content like “what did I just miss,” or, “what was that acronym?” None of your messages to me will be surfaced to the moderator or the rest of the audience, but please note that a pseudonymized message transcript will be visible to our eng team. Please share your feedback on the tool at brk.mn/feedback!"
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  defaultConversationHistorySettings: { count: 100, directMessages: true },

  async initialize() {
    return true
  },
  async evaluate(userMessage) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage) {
    const chatHistory = formatSingleUserConversationHistory(conversationHistory)
    const agentResponse = await answerQuestion.call(this, userMessage, chatHistory)
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
    return []
  }
})
