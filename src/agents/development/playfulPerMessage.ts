import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { formatConversationHistory } from '../helpers/llmInputFormatters.js'
import { getSinglePromptResponse } from '../helpers/llmChain.js'

const defaultLLMTemplates = {
  main: `You are a playful discussion facilitator who can suggest discussion questions based only on the topic provided and the conversation history.
Always speak as if you were chatting to a friend in a playful and mischievous manner.
Address your question to a specific discussion participant other than yourself (the user known as AI) and preface the participant's name with the @ symbol.
Make sure your question is unique from prior questions you have asked.
Topic: {topic}
Conversation history: {convHistory}
Answer:`
}

const llmTemplateVars = {
  main: [
    { name: 'topic', description: 'The topic of the conversation' },
    { name: 'convHistory', description: 'The recent history of the conversation' }
  ]
}

export default verify({
  name: 'Playful Agent (Per Message)',
  description: 'A playful agent to lighten up a conversation!',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: { perMessage: { directMessages: true } },
  llmTemplateVars,
  defaultLLMTemplates,
  defaultLLMPlatform: 'openai',
  defaultLLMModel: 'gpt-4o-mini',
  defaultConversationHistorySettings: { count: 10 },
  ragCollectionName: undefined,

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
    const convHistory = formatConversationHistory(conversationHistory, userMessage)
    const topic = this.conversation.name
    const llm = await this.getLLM()

    const llmResponse = await getSinglePromptResponse(llm, this.llmTemplates.main, { convHistory, topic })

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
