import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import logger from '../../config/logger.js'
import getDefaultEventAssistantToolNames from './eventAssistantDefaultTools.js'
import { extractVoiceQuestion, evaluateVoiceTrigger } from '../helpers/voiceDirectives.js'
import websocketGateway from '../../websockets/websocketGateway.js'

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
    tools: getDefaultEventAssistantToolNames(),
    voiceOutput: false
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
    const questionMessage = { ...userMessage, body: questionText }

    const voiceOutput = Boolean(this.agentConfig.voiceOutput)
    const conversationId = this.conversation._id.toString()
    const requestId = (userMessage.source?.requestId as string | undefined) ?? userMessage._id?.toString() ?? conversationId
    const onChunk = voiceOutput
      ? (text: string) => {
          websocketGateway
            .broadcastMessageChunk(conversationId, [chatChannel.name], { requestId, text, done: false })
            .catch((err) => logger.warn(`Voice assistant: failed to broadcast chunk: ${err}`))
        }
      : undefined

    // answerQuestion expects chat/DM history; transcript is handled internally via RAG
    const responses = await answerQuestion.call(this, questionMessage, { messages: [] }, { voiceOutput, onChunk })

    if (voiceOutput) {
      await websocketGateway
        .broadcastMessageChunk(conversationId, [chatChannel.name], { requestId, text: '', done: true })
        .catch((err) => logger.warn(`Voice assistant: failed to broadcast done marker: ${err}`))
    }

    // Always post the full answer to the chat channel, even in voiceOutput mode. The spoken
    // audio (streamed above via chunks) is ephemeral — the chat message is the durable record
    // of what the bot said. There is no way to coordinate with the output-media server to delay
    // this until audio finishes playing, so the text may appear in chat while the bot is still
    // speaking; for typical short voice answers this overlap is brief.
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
