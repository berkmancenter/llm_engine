import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { quoteAppearsIn } from './spikeAnnotation.js'
import { VIBES_RECEPTION_SYSTEM_PROMPT, VIBES_RECEPTION_USER_TEMPLATE } from './prompt.js'
import { QuoteReception, ReceptionSentiment } from '../../types/index.types.js'

/* A message the reception logic can read: the text, who said it, when, and which
   channel it belongs to (so transcript speaker lines and chat replies stay separate). */
export interface ReceptionMessage {
  body?: unknown
  pseudonym?: string
  fromAgent?: boolean
  createdAt?: Date
  channels?: string[]
}

/* A speaker line that cleared the reaction floor, paired with the chat that followed
   it. The model later turns this into a QuoteReception; until then it is just the raw
   window of evidence. */
export interface SparkCandidate {
  sparkMessage: ReceptionMessage
  reactionVolume: number
  reactionChat: ReceptionMessage[]
}

/* At most this many receptions per event. A recap rarely shows more than two standouts,
   so pulling the two strongest is enough and keeps model calls low. */
export const MAX_RECEPTIONS = 2

/* How long after a speaker line we still count chat as a reaction to it. Three minutes
   captures the immediate response without bleeding into the next topic. */
export const REACTION_WINDOW_MINUTES = 3

/* The reaction floor scales with the room: a tenth of the posters, but never fewer
   than this many, so a handful of replies in a tiny event can still count while a
   couple of stray messages in a large one cannot. Mirrors the spike floor from #13. */
const RECEPTION_FLOOR_FRACTION = 0.1
const RECEPTION_ABSOLUTE_FLOOR = 3

const VALID_SENTIMENTS: ReceptionSentiment[] = ['agreement', 'pushback', 'mixed']

/* A message counts toward a reaction only when a participant wrote real text. Bot
   replies and non-text bodies are not the audience reacting. */
function isParticipantText(message: ReceptionMessage): boolean {
  return !message.fromAgent && typeof message.body === 'string'
}

function reactionFloor(posterCount: number): number {
  return Math.max(RECEPTION_ABSOLUTE_FLOOR, Math.ceil(posterCount * RECEPTION_FLOOR_FRACTION))
}

/* The participant chat sent in the window just after a spark line: from the line's
   time (inclusive) to REACTION_WINDOW_MINUTES later (exclusive). */
function reactionDuring(sparkTime: Date, chatMessages: ReceptionMessage[]): ReceptionMessage[] {
  const windowStart = sparkTime.getTime()
  const windowEnd = windowStart + REACTION_WINDOW_MINUTES * 60 * 1000

  return chatMessages.filter((message) => {
    if (!isParticipantText(message) || !(message.createdAt instanceof Date)) return false
    const sentAt = message.createdAt.getTime()
    return sentAt >= windowStart && sentAt < windowEnd
  })
}

/**
 * Picks the speaker lines that drew the biggest chat reactions. Each transcript line
 * is scored by how much participant chat landed in the window after it; lines that
 * clear the room-scaled floor become candidates. Candidates are taken strongest
 * first, and any that overlaps an already-picked line's window is skipped so the same
 * burst of chat is never credited to two lines. The result is capped at MAX_RECEPTIONS.
 */
export function selectSparkCandidates(
  transcriptMessages: ReceptionMessage[],
  chatMessages: ReceptionMessage[],
  posterCount: number
): SparkCandidate[] {
  const floor = reactionFloor(posterCount)

  const candidates: SparkCandidate[] = transcriptMessages
    .filter((message) => isParticipantText(message) && message.createdAt instanceof Date)
    .map((sparkMessage) => {
      const reactionChat = reactionDuring(sparkMessage.createdAt as Date, chatMessages)
      return { sparkMessage, reactionVolume: reactionChat.length, reactionChat }
    })
    .filter((candidate) => candidate.reactionVolume >= floor)

  // Strongest reaction first; ties broken by the earlier line so selection is stable.
  candidates.sort((a, b) => {
    if (b.reactionVolume !== a.reactionVolume) return b.reactionVolume - a.reactionVolume
    return (a.sparkMessage.createdAt as Date).getTime() - (b.sparkMessage.createdAt as Date).getTime()
  })

  const windowMs = REACTION_WINDOW_MINUTES * 60 * 1000
  const selected: SparkCandidate[] = []
  for (const candidate of candidates) {
    if (selected.length >= MAX_RECEPTIONS) break
    const sparkTime = (candidate.sparkMessage.createdAt as Date).getTime()
    const overlapsSelected = selected.some(
      (chosen) => Math.abs(sparkTime - (chosen.sparkMessage.createdAt as Date).getTime()) < windowMs
    )
    if (!overlapsSelected) selected.push(candidate)
  }

  return selected
}

function isValidSentiment(value: string): value is ReceptionSentiment {
  return (VALID_SENTIMENTS as string[]).includes(value)
}

/**
 * The trust gate for one reception. The model's spark quote must be verbatim text
 * from the speaker line, the reaction quote must be verbatim text from the chat that
 * followed, and the sentiment must be one of the known labels. Anything the model
 * invented or mislabeled is dropped, so a sentiment never reaches the card on the back
 * of words no one said.
 */
export function groundReception(
  candidate: { sparkMessage: { body?: unknown }; reactionVolume: number; reactionChat: { body?: unknown }[] },
  result: { sparkQuote: string; reactionQuote: string; sentiment: string }
): QuoteReception | null {
  const { sentiment } = result
  if (!isValidSentiment(sentiment)) return null
  if (!quoteAppearsIn(result.sparkQuote, [candidate.sparkMessage])) return null
  if (!quoteAppearsIn(result.reactionQuote, candidate.reactionChat)) return null

  return {
    sparkQuote: result.sparkQuote.trim(),
    reactionVolume: candidate.reactionVolume,
    reactionQuote: result.reactionQuote.trim(),
    sentiment
  }
}

/* What the reception labeler returns: a verbatim spark phrase, a verbatim reaction
   quote, and a sentiment. Both quotes are re-checked against the source before they
   are trusted, so the schema only shapes the model's reply. */
const ReceptionSchema = z.object({
  sparkQuote: z.string().describe('The exact words from the speaker line that drew the reaction, copied verbatim'),
  reactionQuote: z.string().describe('One chat reply copied word for word, exactly as it appears'),
  sentiment: z.enum(['agreement', 'pushback', 'mixed']).describe('How the chat responded to the speaker line')
})

function sparkText(message: ReceptionMessage): string {
  return typeof message.body === 'string' ? message.body : ''
}

/* Renders the reaction chat as one "name: text" line each, the form the labeler reads.
   Only text bodies are shown, since a quote can only come from text. */
function formatReactionMessages(messages: ReceptionMessage[]): string {
  return messages
    .filter((message) => typeof message.body === 'string')
    .map((message) => `${message.pseudonym ?? 'someone'}: ${message.body as string}`)
    .join('\n')
}

/* Asks the model how the chat received one speaker line. */
async function requestReception(
  candidate: SparkCandidate,
  llm
): Promise<{ sparkQuote: string; reactionQuote: string; sentiment: string }> {
  return (await getChatPromptResponse(
    llm,
    VIBES_RECEPTION_SYSTEM_PROMPT,
    VIBES_RECEPTION_USER_TEMPLATE,
    { sparkLine: sparkText(candidate.sparkMessage), reactionMessages: formatReactionMessages(candidate.reactionChat) },
    undefined,
    ReceptionSchema
  )) as { sparkQuote: string; reactionQuote: string; sentiment: string }
}

function onChannel(message: ReceptionMessage, channel: string): boolean {
  return Array.isArray(message.channels) && message.channels.includes(channel)
}

/**
 * Finds the speaker moments that drew a chat reaction and labels how the room
 * responded. It splits the readable messages into transcript speaker lines and chat
 * replies, picks the strongest spark candidates, and for each asks the model for a
 * spark quote, a reaction quote, and a sentiment. Only receptions whose quotes are
 * verbatim and whose sentiment is recognized survive the grounding gate; a model
 * failure on one candidate never aborts the rest. Returns an empty list when no
 * speaker line cleared the reaction floor.
 */
export default async function annotateReceptions(
  messages: ReceptionMessage[],
  posterCount: number,
  llm
): Promise<QuoteReception[]> {
  const transcriptMessages = messages.filter((message) => onChannel(message, 'transcript'))
  const chatMessages = messages.filter((message) => onChannel(message, 'chat'))

  const candidates = selectSparkCandidates(transcriptMessages, chatMessages, posterCount)
  if (candidates.length === 0) return []

  const receptions = await Promise.all(
    candidates.map(async (candidate) => {
      let result: { sparkQuote: string; reactionQuote: string; sentiment: string }
      try {
        result = await requestReception(candidate, llm)
      } catch {
        return null
      }
      return groundReception(candidate, result)
    })
  )

  return receptions.filter((reception): reception is QuoteReception => reception !== null)
}
