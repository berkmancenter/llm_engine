import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import { buildSystemPromptWithPersonality } from '../helpers/agentPersonality.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import { checkBotIntent, matchBotMention, normalizeBotMention } from '../helpers/intentChecks.js'
import config from '../../config/config.js'

const BASE_SYSTEM_PROMPT = `You are {botName}, a helpful, knowledgeable AI assistant participating in a group chat. You can engage with any topic or inquiry—from casual conversation to technical questions, creative tasks, analysis, debugging, writing, math, and beyond. There are no subject limits.

**Guidelines:**
- Be direct and substantive. Don't hedge unnecessarily.
- Use conversation history for context—remember what's been discussed.
- For factual questions, be accurate and acknowledge uncertainty when it exists.
- For creative or open-ended tasks, engage fully and offer your perspective.
- Match response depth to the question—short questions don't always need long answers.
- You are talking in a shared channel, so keep context of the group conversation in mind.
- The message you are being asked to respond to is labeled **## Question:**`

export default verify({
  name: 'Chatbot',
  description: 'A general-purpose AI assistant that engages with any inquiry in the chatbot channel',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { channels: ['chatbot'] }
  },
  agentConfig: {
    enablePersonality: config.enableAgentPersonality
  },
  llmTemplateVars: {
    user: [{ name: 'question', description: 'The user message or question' }]
  },
  defaultLLMTemplates: {
    user: '## Question:\n{question}'
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 100, channels: ['chatbot'] },

  async evaluate(userMessage) {
    const words = userMessage?.body?.trim().split(/\s+/) ?? []
    const modifiedMessage = matchBotMention(words, this.agentConfig.botName)
      ? { ...userMessage, body: normalizeBotMention(userMessage.body, this.agentConfig.botName) }
      : userMessage
    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const llm = await this.getLLM()
    if (!(await checkBotIntent(llm, this.agentConfig.botName, userMessage))) {
      return []
    }
    const chatHistory = formatMultiUserConversationHistory(conversationHistory)

    // Keep the @BotName mention in the question so the LLM can see it is addressed directly,
    // consistent with how bot-directed messages appear in conversation history.
    const question = extractMessageText(userMessage).trim()

    // Determine personality: agentConfig.personality takes precedence, then global flag
    let personalityName: string | null = null
    if (this.agentConfig?.personality !== undefined) {
      personalityName = this.agentConfig.personality
    } else if (config.enableAgentPersonality) {
      personalityName = 'sarcastic-expert'
    }

    const systemPrompt = buildSystemPromptWithPersonality(
      BASE_SYSTEM_PROMPT.replace('{botName}', this.agentConfig.botName),
      personalityName
    )

    const response = await getChatPromptResponse(
      llm,
      systemPrompt,
      this.llmTemplates.user,
      { question },
      chatHistory,
      undefined,
      this.llmPlatform
    )

    const responseChannels = this.conversation.channels.filter((channel) => channel.name === 'chatbot')

    // If question is already part of a thread, reply in the thread. Otherwise, reply in the main channel.
    const parentMessageId = userMessage.parentMessage

    return [
      {
        visible: true,
        message: response,
        messageType: 'text',
        channels: responseChannels,
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
