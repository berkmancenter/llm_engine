import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import logger from '../../config/logger.js'
import getDefaultEventAssistantToolNames from './eventAssistantDefaultTools.js'
import { extractVoiceQuestion, evaluateVoiceTrigger } from '../helpers/voiceDirectives.js'

export default verify({
  name: 'Voice Assistant',
  description:
    'Listens for voice activations on the transcript channel and answers questions about the event in the group chat',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { channels: ['transcript'] }
  },
  agentConfig: {
    tools: getDefaultEventAssistantToolNames()
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  defaultConversationHistorySettings: { count: 10, channels: ['transcript'] },
  parseOutput: (msg) => {
    if (msg.bodyType !== 'json' || msg.body?.source !== 'voice') {
      return msg
    }
    const translatedMsg = msg.toObject()
    const sourceMessage = msg.body.sourceMessage as string
    const truncated = sourceMessage.length > 40 ? `${sourceMessage.slice(0, 40)}...` : sourceMessage
    translatedMsg.bodyType = 'text'
    translatedMsg.body = `🔊 "${truncated}"\n${msg.body.text}`
    return translatedMsg
  },

  async evaluate(userMessage) {
    const botName = this.agentConfig.botName as string
    const result = evaluateVoiceTrigger(userMessage, botName, this.conversation.messages as Array<IMessage>)
    if (result.action === AgentMessageActions.CONTRIBUTE) logger.debug(`Voice trigger matched`)
    else if (result.userMessage !== userMessage) logger.debug(`Voice trigger matched (bare), waiting for next message`)
    return result
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const chatChannel = this.conversation.channels.find((channel) => channel.name === 'chat')
    if (!chatChannel) return []

    const botName = this.agentConfig.botName as string
    const questionText = extractVoiceQuestion(userMessage, conversationHistory.messages, botName)
    if (!questionText) return []

    logger.debug(`Voice assistant answering question: "${questionText}"`)
    // answerQuestion expects chat/DM history; transcript is handled internally via RAG
    const questionMessage = { ...userMessage, body: questionText }
    const responses = await answerQuestion.call(this, questionMessage, { messages: [] })

    return responses.map((r) => ({
      ...r,
      channels: [chatChannel],
      parent: undefined,
      message: {
        ...r.message,
        source: 'voice',
        sourceMessage: questionText,
        sourcePseudonym: userMessage.pseudonym
      }
    }))
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
    return []
  },
  formatTraceInput(conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0]?.message.text
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      context: responses[0]?.context,
      conversationHistory,
      channels: userMessage?.channels,
      promptType: responses[0]?.promptType,
      topic: responses[0]?.topic
    }
  }
})
