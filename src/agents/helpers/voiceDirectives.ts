import { AgentMessageActions } from '../../types/index.types.js'
import type { IMessage } from '../../types/index.types.js'
import { extractMessageText } from './slashCommandParser.js'
import { matchBotMention, normalizeBotMention } from './intentChecks.js'

/**
 * Checks whether a text message contains a "hey <botName>" wake-word directive anywhere
 * and returns the question text that follows it (if any).
 *
 * "hey" is checked for an EXACT match (not fuzzy). It is a short, common, unambiguous
 * word that speech-to-text transcribes reliably. Fuzzy matching "hey" backfired: fuzzball
 * scores "they" at 86 against "hey" (above any reasonable threshold), so any message
 * containing "they"/"their" immediately followed by anything resembling the bot name
 * would trigger a spurious response.
 *
 * The bot name token IS fuzzy-matched (via matchBotMention) since ASR frequently
 * mistranscribes unfamiliar names.
 */
function matchHeyDirective(text: string, botName: string): { matched: boolean; question: string } {
  const words = text.trim().split(/\s+/)
  if (words.length < 2) return { matched: false, question: '' }

  for (let i = 0; i < words.length - 1; i++) {
    const heyToken = words[i].replace(/[,!.]+$/, '').toLowerCase()
    if (heyToken === 'hey' && matchBotMention([words[i + 1]], botName)) {
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

/**
 * Returns the extracted question text if a voice agent should respond to userMessage,
 * or null otherwise.
 *
 * Handles two activation patterns:
 * 1. "hey <botName>, <question>" — question is extracted from the same message.
 * 2. "hey <botName>" (bare) followed by a separate message — the follow-up message
 *    becomes the question.
 *
 */
export function extractVoiceQuestion(
  userMessage: IMessage,
  conversationMessages: IMessage[],
  botName: string
): string | null {
  const messageText = extractMessageText(userMessage)
  const { matched, question } = matchHeyDirective(messageText, botName)

  if (matched && question) return question
  if (matched && !question) return null // bare trigger — wait for next message

  // No trigger in current message — check if the previous transcript message was a bare "hey <botName>"
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

/**
 * Standard evaluate result for voice-triggered agents.
 *
 * Returns CONTRIBUTE when a question is ready, OK (with normalized body) for a bare
 * "hey <botName>" trigger, or OK (unchanged) when no trigger is detected.
 * Agents with additional pre-checks should handle those
 * before calling this.
 */
export function evaluateVoiceTrigger(userMessage: IMessage, botName: string, conversationMessages: IMessage[]) {
  const questionText = extractVoiceQuestion(userMessage, conversationMessages, botName)
  if (questionText) {
    const modifiedMessage = { ...userMessage, body: normalizeBotMention(userMessage.body as string, botName, false) }
    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  }

  const messageText = extractMessageText(userMessage)
  const { matched } = matchHeyDirective(messageText, botName)
  if (matched) {
    const modifiedMessage = { ...userMessage, body: normalizeBotMention(userMessage.body as string, botName, false) }
    return {
      userMessage: modifiedMessage,
      action: AgentMessageActions.OK,
      userContributionVisible: true,
      suggestion: undefined
    }
  }

  return { userMessage, action: AgentMessageActions.OK, userContributionVisible: true, suggestion: undefined }
}
