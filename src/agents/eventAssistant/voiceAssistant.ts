import * as fuzzball from 'fuzzball'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import logger from '../../config/logger.js'
import getDefaultEventAssistantToolNames from './eventAssistantDefaultTools.js'

const heyMatchThreshold = 85
const nameMatchThreshold = 70

function matchHeyDirective(text: string, botName: string): { matched: boolean; question: string } {
  // Split and scan all consecutive word pairs for "hey <botName>" anywhere in the message
  const words = text.trim().split(/\s+/)
  if (words.length < 2) return { matched: false, question: '' }

  for (let i = 0; i < words.length - 1; i++) {
    const heyToken = words[i].replace(/[,!.]+$/, '')
    const nameToken = words[i + 1].replace(/[,!.]+$/, '').toLowerCase()

    const heyScore = fuzzball.ratio(heyToken.toLowerCase(), 'hey')
    const nameScore = fuzzball.ratio(nameToken, botName.toLowerCase())

    if (heyScore >= heyMatchThreshold && nameScore >= nameMatchThreshold) {
      const extracted = words
        .slice(i + 2)
        .join(' ')
        .trim()
      const question = extracted.charAt(0).toUpperCase() + extracted.slice(1)
      return { matched: true, question }
    }
  }

  return { matched: false, question: '' }
}

// Returns the extracted question text if the voice assistant should respond, or null otherwise.
// Called from both evaluate (to gate) and respond (to extract the question), since respond runs
// asynchronously in a job with a freshly loaded agent and cannot rely on in-memory state from evaluate.
function extractVoiceQuestion(userMessage, conversationMessages, botName: string) {
  const messageText = extractMessageText(userMessage)
  const { matched, question } = matchHeyDirective(messageText, botName)

  if (matched && question) return question
  if (matched && !question) return null // bare trigger, wait for next message

  // No trigger in current message — check if the previous transcript message was a bare "hey botName"
  const prevTranscriptMessage = [...conversationMessages]
    .reverse()
    .find((msg) => msg.channels?.some((c) => c === 'transcript'))
  if (prevTranscriptMessage) {
    const prevText = extractMessageText(prevTranscriptMessage)
    const prev = matchHeyDirective(prevText, botName)
    if (prev.matched && !prev.question) return messageText
  }

  return null
}

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
    const questionText = extractVoiceQuestion(userMessage, this.conversation.messages as Array<IMessage>, botName)

    if (questionText) {
      logger.debug(`Voice trigger matched, question: "${questionText}"`)
      return { userMessage, action: AgentMessageActions.CONTRIBUTE, userContributionVisible: true, suggestion: undefined }
    }

    const messageText = extractMessageText(userMessage)
    const { matched } = matchHeyDirective(messageText, botName)
    if (matched) logger.debug(`Voice trigger matched (bare), waiting for next message`)

    return { userMessage, action: AgentMessageActions.OK, userContributionVisible: true, suggestion: undefined }
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
