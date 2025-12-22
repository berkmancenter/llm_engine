import logger from '../../config/logger.js'
import { IMessage, ConversationHistory, ConversationHistorySettings } from '../../types/index.types'
import getConversationHistory from './getConversationHistory.js'

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function formatTranscriptMessage(message) {
  return `[${formatTime(message.createdAt)}] ${message.body}`
}

function formatTranscript(messages) {
  return messages.map((msg) => formatTranscriptMessage(msg)).join('\n')
}

function findNearbyTranscriptMessages(participantMsg, transcript, timeWindow = 15) {
  const matchingMessages: IMessage[] = []

  // Find messages in the transcript that are within ±15 seconds
  const participantTime = new Date(participantMsg.createdAt).getTime()

  transcript.forEach((transcriptMsg) => {
    const transcriptTime = new Date(transcriptMsg.createdAt).getTime()
    const timeDiff = Math.abs(transcriptTime - participantTime)
    if (timeDiff <= timeWindow * 1000) {
      matchingMessages.push(transcriptMsg)
    }
  })

  matchingMessages.sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime())
  return matchingMessages.map((message) => formatTranscriptMessage(message))
}

function formatMessage(message, structured = false, transcriptMsgs?) {
  if (structured) {
    const messageText = message.bodyType === 'json' ? message.body.text : message.body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formattedMsg: any = {
      comment: { user: message.pseudonym, timestamp: formatTime(message.createdAt), text: messageText }
    }
    if (transcriptMsgs) {
      formattedMsg.transcript = transcriptMsgs
    }
    return formattedMsg
  }
  if (message.bodyType === 'json') {
    return `${message.pseudonym}: "${JSON.stringify(message.body)}"`
  }
  return `${message.pseudonym}: "${message.body}"`
}

function formatMessages(messages, structured = false, transcriptMessages?, transcriptTimeWindow?) {
  return messages.map((message) => {
    const transcriptMsgs = transcriptMessages
      ? findNearbyTranscriptMessages(message, transcriptMessages, transcriptTimeWindow)
      : undefined
    return formatMessage(message, structured, transcriptMsgs)
  })
}

function formatAndFilterMessages(messages, settings: ConversationHistorySettings = { count: 10 }) {
  const convHistory = getConversationHistory(messages, settings)
  return formatMessages(convHistory.messages)
}

function formatConversationHistory(conversationHistory: ConversationHistory, userMessage?) {
  const formattedMessages = formatMessages(conversationHistory.messages)
  if (userMessage) formattedMessages.push(formatMessage(userMessage))
  return formattedMessages.join('\n')
}

function formatSingleUserConversationHistory(conversationHistory: ConversationHistory) {
  return conversationHistory.messages.map((message) => {
    let messageText = message.body
    // conversation history messsages must be strings. If json, assume it has a 'text' property
    if (message.bodyType === 'json') {
      if (!(message.body as Record<string, unknown>).text) {
        logger.warn(`Message with ID ${message._id} has bodyType 'json' but no 'text' property. Defaulting to empty string.`)
        messageText = ''
      } else {
        messageText = (message.body as Record<string, unknown>).text as string
      }
    }
    if (message.fromAgent) {
      return { role: 'assistant', content: messageText }
    }
    return { role: 'user', content: messageText }
  })
}

/**
 *
 * @param {*} phases An array of ConversationPhases
 * @returns A string formatting the conversation into "chunks" to use for LLM prompting
 */
function formatConversationPhases(phases) {
  const conversationHistory: { question: string; conversation: string[] }[] = []

  for (const phase of phases) {
    conversationHistory.push({
      question: formatMessage(phase.question),
      conversation: formatAndFilterMessages(phase.conversation, { count: phase.conversation.length })
    })
  }

  const chunks = conversationHistory
    .map(
      (chunk, index) =>
        `**Chunk ${index + 1}:**\n**Question:** ${chunk.question}\n**Conversation:**\n- ${chunk.conversation.join('\n- ')}`
    )
    .join('\n\n')
  return chunks
}

export {
  formatConversationHistory,
  formatConversationPhases,
  formatMessage,
  formatMessages,
  formatSingleUserConversationHistory,
  formatTranscript,
  formatTime
}
