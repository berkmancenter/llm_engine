import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'

const defaultLLMTemplates = {
  system: `You are a playful discussion facilitator who can suggest discussion questions based only on the topic provided and the conversation history.
Always speak as if you were chatting to a friend in a playful and mischievous manner.
Address your question to a specific discussion participant other than yourself (the user known as AI) and preface the participant's name with the @ symbol.
Make sure your question is unique from prior questions you have asked.`,
  user: `Topic: {topic}
Answer:`
}

const llmTemplateVars = {
  system: [],
  user: [{ name: 'topic', description: 'The topic of the conversation' }]
}

export default verify({
  name: 'Playful Agent (Per Message)',
  description: 'A playful agent to lighten up a conversation!',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: { perMessage: { directMessages: true } },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  defaultConversationHistorySettings: { count: 10 },
  ragCollectionName: undefined,

  async evaluate(userMessage) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },
  async respond(conversationHistory: ConversationHistory, userMessage) {
    const chatHistory = formatMultiUserConversationHistory(conversationHistory)
    const topic = this.conversation.name
    const llm = await this.getLLM()

    const llmResponse = await getChatPromptResponse(
      llm,
      this.llmTemplates.system,
      this.llmTemplates.user,
      { topic },
      chatHistory
    )

    const agentResponse = {
      visible: true,
      message: llmResponse,
      channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name))
    }
    return [agentResponse]
  },
  async start() {
    return true
  },
  async stop() {
    return true
  }
})
