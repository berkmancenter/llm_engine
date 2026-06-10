import logger from '../../config/logger.js'
import { IMessage, IChannel, IChannelBreakout, ConversationHistory, ConversationHistorySettings } from '../../types/index.types'
import getConversationHistory from './getConversationHistory.js'

function formatTime(date, timezone = 'UTC') {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: timezone
  })
}

function formatTranscriptMessage(message, timezone = 'UTC') {
  return `[${formatTime(message.createdAt, timezone)}] ${message.body}`
}

function formatTranscript(messages, timezone = 'UTC') {
  return messages.map((msg) => formatTranscriptMessage(msg, timezone)).join('\n')
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
    const messageText = message.bodyType === 'json' || message.bodyType === 'multimodal' ? message.body.text : message.body
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
  if (message.bodyType === 'multimodal') {
    return `${message.pseudonym}: "${message.body.text}"`
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

function buildBreakoutRoomLabels(agent): Map<string, string> | undefined {
  if (!agent.conversationHistorySettings?.includeBreakouts) return undefined
  const map = new Map<string, string>()
  for (const channel of agent.conversation.channels as IChannel[]) {
    if (channel.breakout) {
      const label = (channel.breakout as IChannelBreakout).name || (channel.breakout as IChannelBreakout).roomId
      map.set(channel.name, label)
    }
  }
  return map.size > 0 ? map : undefined
}

function formatAndFilterMessages(messages, settings: ConversationHistorySettings = { count: 10 }) {
  const convHistory = getConversationHistory(messages, settings)
  return formatMessages(convHistory.messages)
}

function formatSingleUserConversationHistory(conversationHistory: ConversationHistory) {
  return conversationHistory.messages?.map((message) => {
    let messageText = message.body
    // conversation history messsages must be strings. If json or multimodal, assume it has a 'text' property
    if (message.bodyType === 'json' || message.bodyType === 'multimodal') {
      if (!(message.body as Record<string, unknown>).text) {
        logger.warn(`Message with ID ${message._id} has bodyType '${message.bodyType}' but no 'text' property. Defaulting to empty string.`)
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

function formatMultiUserConversationHistory(conversationHistory: ConversationHistory, agent?) {
  const breakoutRoomLabels = agent ? buildBreakoutRoomLabels(agent) : undefined
  return conversationHistory.messages?.flatMap((message) => {
    let messageText = message.body
    // conversation history messsages must be strings. If json or multimodal, assume it has a 'text' property
    if (message.bodyType === 'json' || message.bodyType === 'multimodal') {
      if (!(message.body as Record<string, unknown>).text) {
        logger.warn(`Message with ID ${message._id} has bodyType '${message.bodyType}' but no 'text' property. Defaulting to empty string.`)
        messageText = ''
      } else {
        messageText = (message.body as Record<string, unknown>).text as string
      }
    }

    // When reconvened history includes breakout channels, prefix with room label so the
    // LLM can distinguish which room each message came from.
    const roomLabel = breakoutRoomLabels
      ? message.channels?.map((c) => breakoutRoomLabels.get(c)).find(Boolean)
      : undefined
    const roomPrefix = roomLabel ? `[${roomLabel}] ` : ''

    if (message.fromAgent) {
      // For voice assistant responses, prepend the original question so other agents
      // see the full exchange rather than an unexplained answer
      const body = message.body as Record<string, unknown>
      if (body?.source === 'voice' && body?.sourceMessage) {
        const asker = (body.sourcePseudonym as string) || 'User'
        return [
          { role: 'user', content: `${roomPrefix}${asker}: ${body.sourceMessage}` },
          { role: 'assistant', content: `${roomPrefix}${messageText}` }
        ]
      }
      return { role: 'assistant', content: `${roomPrefix}${messageText}` }
    }
    // For multi-user environments, include the pseudonym in the content
    return { role: 'user', content: `${roomPrefix}${message.pseudonym}: ${messageText}` }
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
  formatConversationPhases,
  formatMessage,
  formatMessages,
  formatSingleUserConversationHistory,
  formatMultiUserConversationHistory,
  formatTranscript,
  formatTime
}
