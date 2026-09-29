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
    const botName = this.agentConfig.botName as string
    const questionText = extractVoiceQuestion(userMessage, conversationHistory.messages, botName)
    if (!questionText) return []

    logger.debug(`Voice assistant answering question: "${questionText}"`)
    const questionMessage = { ...userMessage, body: questionText }

    const voiceOutput = Boolean(this.agentConfig.voiceOutput)
    const conversationId = this.conversation._id.toString()

    if (voiceOutput) {
      // In voice output mode, stream chunks on the transcript channel for clients to consume for TTS.
      // No message is saved or broadcast — the durable record of
      // what the bot said comes from transcribing the spoken audio back.
      const transcriptChannel = this.conversation.channels.find((channel) => channel.name === 'transcript')
      if (!transcriptChannel) return []

      const requestId =
        (userMessage.source?.requestId as string | undefined) ?? userMessage._id?.toString() ?? conversationId
      let chunkStreamed = false
      const onChunk = (text: string) => {
        chunkStreamed = true
        websocketGateway
          .broadcastMessageChunk(conversationId, [transcriptChannel.name], { requestId, text, done: false })
          .catch((err) => logger.warn(`Voice assistant: failed to broadcast chunk: ${err}`))
      }

      try {
        // answerQuestion expects chat/DM history; transcript is handled internally via RAG
        const responses = await answerQuestion.call(this, questionMessage, { messages: [] }, { voiceOutput, onChunk })

        // Not every path inside answerQuestion streams via onChunk — e.g. the no-tools branch
        // resolves the full answer in one shot with no chunk callback at all. Without this
        // fallback that answer is silently dropped: never streamed, never persisted, the
        // client only ever sees an empty done:true marker. Covers any other future path that
        // resolves without streaming too, with no changes needed there.
        if (!chunkStreamed) {
          const fullText = responses[0]?.message?.text
          if (fullText) {
            await websocketGateway
              .broadcastMessageChunk(conversationId, [transcriptChannel.name], { requestId, text: fullText, done: false })
              .catch((err) => logger.warn(`Voice assistant: failed to broadcast fallback chunk: ${err}`))
          }
        }
      } finally {
        // Always send the done marker, even if answerQuestion threw partway through (LLM/tool
        // calls, the RAG lookup) — chunks may already be streaming by then, and a client that's
        // received done:false chunks for this requestId must still learn the stream ended.
        await websocketGateway
          .broadcastMessageChunk(conversationId, [transcriptChannel.name], { requestId, text: '', done: true })
          .catch((err) => logger.warn(`Voice assistant: failed to broadcast done marker: ${err}`))
      }

      return []
    }

    const chatChannel = this.conversation.channels.find((channel) => channel.name === 'chat')
    if (!chatChannel) return []

    // answerQuestion expects chat/DM history; transcript is handled internally via RAG
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
