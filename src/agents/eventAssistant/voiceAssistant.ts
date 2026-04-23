import * as fuzzball from 'fuzzball'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { eventAssistantLLMTemplates, eventAssistantLlmTemplateVars, answerQuestion } from './eventQuestionHandler.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import logger from '../../config/logger.js'

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

export default verify({
  name: 'Voice Assistant',
  description:
    'Listens for voice activations on the transcript channel and answers questions about the event in the group chat',
  priority: 100,
  maxTokens: 2000,
  defaultTriggers: {
    perMessage: { channels: ['transcript'] }
  },
  llmTemplateVars: eventAssistantLlmTemplateVars,
  defaultLLMTemplates: eventAssistantLLMTemplates,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  defaultConversationHistorySettings: { count: 10, channels: ['transcript'] },
  parseOutput: (msg) => {
    if (msg.bodyType !== 'json' || msg.body?.source !== 'voice') {
      return msg
    }
    const translatedMsg = msg.toObject()
    const sourceMessage = msg.body.sourceMessage as string
    const truncated = sourceMessage.length > 25 ? `${sourceMessage.slice(0, 25)}...` : sourceMessage
    translatedMsg.bodyType = 'text'
    translatedMsg.body = `🔊 "${truncated}"\n${msg.body.text}`
    return translatedMsg
  },

  async initialize() {
    return true
  },

  async evaluate(userMessage) {
    return { userMessage, action: AgentMessageActions.CONTRIBUTE, userContributionVisible: true, suggestion: undefined }
  },

  async respond(conversationHistory: ConversationHistory, userMessage) {
    const chatChannel = this.conversation.channels.find((channel) => channel.name === 'chat')
    if (!chatChannel) return []

    const messageText = extractMessageText(userMessage)
    const botName = this.agentConfig.botName as string

    const { matched, question } = matchHeyDirective(messageText, botName)

    let questionText

    if (matched && question) {
      // "hey botName <question>" - answer immediately
      logger.debug(`Voice trigger matched with inline question: "${question}"`)
      questionText = question
    } else if (matched && !question) {
      // bare "hey botName" - wait for next message
      logger.debug(`Voice trigger matched (bare), waiting for next message`)
    } else if (!matched) {
      // No trigger in current message - check if the previous transcript message was a bare "hey [botName]"
      const { messages } = conversationHistory
      if (messages.length > 0) {
        const prevMessage = messages[messages.length - 1]
        const prevText = extractMessageText(prevMessage)
        const prev = matchHeyDirective(prevText, botName)
        if (prev.matched && !prev.question) {
          // Previous transcript message was a bare "hey botName" - treat current as the question
          logger.debug(`Voice trigger processing deferred question: "${messageText}"`)
          questionText = messageText
        }
      }
    }

    if (!questionText) return []

    // Pass to answerQuestion with modified body and empty history - conversationHistory here contains
    // transcript messages, but answerQuestion expects chat/DM history; transcript is handled internally via RAG
    logger.debug(`Voice assistant answering question: "${questionText}"`)
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
    return responses[0]?.message
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
