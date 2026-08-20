import logger from '../../config/logger.js'
import { IMessage, IChannel, ConversationHistory, ConversationHistorySettings } from '../../types/index.types'
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
  // Surface diarized speaker labels (e.g. "SPEAKER_00") stored on source.speaker
  // so the LLM can actually distinguish speakers in the transcript when needed.
  const speaker = message.source?.speaker
  const speakerPrefix = speaker ? `[${speaker}] ` : ''
  return `[${formatTime(message.createdAt, timezone)}] ${speakerPrefix}${message.body}`
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

function formatAndFilterMessages(messages, settings: ConversationHistorySettings = { count: 10 }) {
  const convHistory = getConversationHistory(messages, settings)
  return formatMessages(convHistory.messages)
}

function extractMessageText(message: IMessage) {
  const body = message.body as Record<string, unknown>
  if (message.bodyType === 'json' || message.bodyType === 'multimodal') {
    if (body?.type === 'poll') {
      const choices = (body.choices as string[]) ?? []
      const choiceList = choices.map((c) => `- ${c}`).join('\n')
      return `${body.text}\n[Poll: "${body.title}"]\nChoices:\n${choiceList}`
    }
    if (!body?.text) {
      logger.warn(
        `Message with ID ${message._id} has bodyType '${message.bodyType}' but no 'text' property. Defaulting to empty string.`
      )
      return ''
    }
    return body.text as string
  }
  return message.body as string
}

function formatSingleUserConversationHistory(conversationHistory: ConversationHistory) {
  return conversationHistory.messages?.map((message) => {
    const messageText = extractMessageText(message)
    if (message.fromAgent) {
      return { role: 'assistant', content: messageText }
    }
    return { role: 'user', content: messageText }
  })
}

function formatMultiUserConversationHistory(conversationHistory: ConversationHistory) {
  return conversationHistory.messages?.flatMap((message) => {
    const messageText = extractMessageText(message)
    if (message.fromAgent) {
      // For voice assistant responses, prepend the original question so other agents
      // see the full exchange rather than an unexplained answer
      const body = message.body as Record<string, unknown>
      if (body?.source === 'voice' && body?.sourceMessage) {
        const asker = (body.sourcePseudonym as string) || 'User'
        return [
          { role: 'user', content: `${asker}: ${body.sourceMessage}` },
          { role: 'assistant', content: messageText }
        ]
      }
      return { role: 'assistant', content: messageText }
    }
    // For multi-user environments, include the pseudonym in the content
    return { role: 'user', content: `${message.pseudonym}: ${messageText}` }
  })
}

/**
 * Formats DM history grouped by channel, clearly labelling which participant each
 * agent message was sent to. This prevents LLMs from mistaking 50 separately-addressed
 * checkin messages as duplicates, and from attributing another participant's conversation
 * history to the participant currently being evaluated.
 *
 * Accepts full IChannel objects so it can derive the participant pseudonym from
 * channel.participants as a fallback — needed when a channel contains only agent-sent
 * messages (e.g. a jargon filter DM before the user has replied).
 *
 * Returns a plain string suitable for use as an LLM template variable.
 */
function formatDmHistoryByChannel(messages: IMessage[], dmChannels: IChannel[]): string {
  const channelBuckets = new Map<string, IMessage[]>()
  for (const ch of dmChannels) {
    channelBuckets.set(ch.name, [])
  }
  for (const msg of messages) {
    for (const ch of msg.channels ?? []) {
      channelBuckets.get(ch)?.push(msg)
    }
  }

  // Build a fallback pseudonym map from channel.participants for channels where the user
  // has not yet sent any messages (e.g. proactive agent outreach).
  // Use the discriminator key __t to identify the non-agent participant.
  const participantFallback: Record<string, string> = {}
  for (const ch of dmChannels) {
    const participant = ch.participants?.find((p) => p.__t !== 'Agent')
    const pseudonym = participant?.activePseudonym?.pseudonym
    if (pseudonym) participantFallback[ch.name] = pseudonym
  }

  const sections: string[] = []
  for (const [channelName, msgs] of channelBuckets) {
    if (msgs.length === 0) continue

    const participantPseudonym =
      msgs.find((m) => !m.fromAgent)?.pseudonym ?? participantFallback[channelName] ?? 'Participant'

    const lines = msgs.map((msg) => {
      const text = extractMessageText(msg)
      return msg.fromAgent ? `Assistant (to ${participantPseudonym}): "${text}"` : `${participantPseudonym}: "${text}"`
    })

    sections.push(`[DM — ${participantPseudonym}]\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
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
  formatDmHistoryByChannel,
  formatTranscript,
  formatTime
}
