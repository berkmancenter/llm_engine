import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { z } from 'zod'
import config from '../../config/config.js'
import { getBedrockChat } from '../helpers/getModelChat.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import PLAIN_LANGUAGE_TERM_RULES from '../helpers/plainLanguageRules.js'
import UnpackRequest from '../../models/unpackRequest.model.js'
import logger from '../../config/logger.js'
import { findMessages } from '../../utils/messageVisibility.js'
import {
  AgentResponse,
  CatchUpRefusalReason,
  CatchUpRefused,
  CatchUpSummary,
  CatchUpSummarySections,
  IChannel,
  TRANSCRIPT_CHANNEL,
  UnpackTranscriptChunk
} from '../../types/index.types.js'
import { chunksStillSaved, isUnpackerEnabled, TRANSCRIPT_TEXT_CHUNKS } from '../helpers/unpackPassage.js'
import ApiError from '../../utils/ApiError.js'
import { assertChannelPasscode } from '../../utils/authChannels.js'

// Transcript chunks only store when the speaker finished, so this compares chunk end times
export const UNPACK_LAST_MINUTE_WINDOW_SECONDS = 60
// Each request is one AI model call, so this caps what one participant can spend
export const UNPACK_REQUESTS_PER_MINUTE = 3
// A minute of fast speech is about 1,000 characters; whole chunks can start well before the minute
export const UNPACK_CATCH_UP_MAX_CHARACTERS = 3000
// A minute of talk is rarely more than 20 chunks; this only bounds the database lookup
const UNPACK_CATCH_UP_MAX_CHUNKS = 50
const CATCH_UP_MAX_POINTS = 5
const CATCH_UP_MAX_OUTPUT_TOKENS = 1000

export const UNPACK_REPLIES: Record<CatchUpRefusalReason, string> = {
  noTranscript:
    "I haven't caught any of the talk yet, so there's nothing to catch you up on. Try again once the speaker has said a bit more.",
  noPassagesSent: "I didn't get any part of the talk to catch you up on. Please try again in a moment.",
  rateLimited:
    "Let's give the speaker a little time to say more. Ask me again in a minute and I'll catch you up on what's new.",
  chunkNotInTranscript: "I couldn't find that part of the talk in this event's transcript. Please try again.",
  passageTooLong: "That's more of the talk than I can catch you up on at once. Please try again in a moment.",
  unpackFailed: "Sorry, I couldn't catch you up just now. Please try again in a moment."
}

const EARLIER_SPEECH_NOTE = `Nothing was said in the last ${UNPACK_LAST_MINUTE_WINDOW_SECONDS} seconds, so this covers what was said just before.`

export const CATCH_UP_SYSTEM_PROMPT = `You catch up a participant at a live event who lost track of the talk. You get the event topic, a note on when the passage was said, and a short passage of the live transcript. Transcription is automatic, so expect missing words and misheard terms, and work out what the speaker most likely meant.

Write these, in this order:
- inShort: two or three sentences on what the speaker said, in plain language.
- whatTheyCovered: two to five short points, one per idea, in the order the speaker raised them. Each point is a phrase or one short sentence.
- comingUp: null, unless the speaker announced what they will show or talk about next, for example "Let me show you..." or "Next I'll cover...". Then say what they announced in one sentence. Never guess what comes next from the topic or the flow of the talk.

Only summarize what is in the passage. Don't add claims the speaker didn't make. If the note says the passage is from earlier, don't describe it as said just now.

## Writing rules
${PLAIN_LANGUAGE_TERM_RULES}`

const CATCH_UP_USER_TEMPLATE = `## Event topic:
{topic}

## When this was said:
{timing}

## Transcript passage:
{transcript}`

const RECENT_SPEECH_TIMING = 'The passage is the last minute of the talk, up to when the participant asked.'
const EARLIER_SPEECH_TIMING = `Nothing was said in the last ${UNPACK_LAST_MINUTE_WINDOW_SECONDS} seconds before the participant asked, so this passage is from a little earlier.`

// Passage asks and Group Chat posts go through the unpack endpoints, never a chat message
const unpackRequestBodySchema = z.object({
  type: z.literal('unpack_request'),
  mode: z.literal('lastMinute'),
  text: z.string(),
  chunkIds: z.array(z.string()).max(UNPACK_CATCH_UP_MAX_CHUNKS),
  destination: z.literal('privateChat').default('privateChat')
})

const catchUpSummarySchema = z.object({
  inShort: z.string(),
  whatTheyCovered: z.array(z.string().min(1)).min(1),
  comingUp: z.string().nullable()
})

export function isUnpackRequest(message): boolean {
  return message?.bodyType === 'json' && message?.body?.type === 'unpack_request'
}

/**
 * Checks a catch-up request's body and transcript passcode while it is being posted, the same checks
 * the passage endpoint makes, and returns it without the passcode so that is never saved in chat history.
 * @throws ApiError 400 for a malformed body, or with reason wrongPasscode for a missing or wrong passcode
 */
export function validateUnpackRequest(conversation, userMessage) {
  const { transcriptPasscode, ...body } = userMessage.body
  const parsed = unpackRequestBodySchema.safeParse(body)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid catch-up request: ${problems}`)
  }
  const transcript = conversation.channels?.find((channel) => channel.name === TRANSCRIPT_CHANNEL)
  if (transcript) assertChannelPasscode(transcript, transcriptPasscode)
  return { ...userMessage, body }
}

function refusal(reason: CatchUpRefusalReason, userMessage, channels: IChannel[]): AgentResponse<CatchUpRefused> {
  return {
    visible: true,
    message: {
      type: 'catch_up_refused',
      requestMessage: userMessage._id.toString(),
      reason,
      text: UNPACK_REPLIES[reason]
    },
    messageType: 'json',
    channels
  }
}

function catchUpPlainText({ inShort, whatTheyCovered, comingUp }: CatchUpSummarySections, earlierSpeech: boolean) {
  const sections = [`In short: ${inShort}`]
  if (earlierSpeech) sections.unshift(EARLIER_SPEECH_NOTE)
  if (whatTheyCovered.length > 0) {
    sections.push(`What they covered:\n${whatTheyCovered.map((point) => `- ${point}`).join('\n')}`)
  }
  if (comingUp) sections.push(`Coming up: ${comingUp}`)
  return sections.join('\n\n')
}

/**
 * When the server received a request, in milliseconds. A websocket client can set createdAt but not _id,
 * so createdAt only counts when it lands just after the whole second stored in the ID.
 */
function receivedAt(message): number {
  const idTime = message._id.getTimestamp().getTime()
  const createdAt = new Date(message.createdAt).getTime()
  // 2s, not 1s: the ID is made before the save sets createdAt, which can tip into the next second
  return createdAt >= idTime && createdAt < idTime + 2000 ? createdAt : idTime
}

/**
 * Counts request messages, saved before any job runs, so quick repeat taps can't all get through. Requests
 * Berkie refused or couldn't parse never reached the AI model, so they don't count against a retry.
 */
function isRateLimited(conversation, userMessage, askedAt: Date): boolean {
  const windowStart = askedAt.getTime() - 60 * 1000
  const refused = new Set(
    (conversation.messages ?? [])
      .filter((message) => message.bodyType === 'json' && message.body?.type === 'catch_up_refused')
      .map((message) => message.body.requestMessage)
  )
  const earlierRequests = (conversation.messages ?? []).filter((message) => {
    if (!isUnpackRequest(message) || message._id.equals(userMessage._id)) return false
    if (refused.has(message._id.toString()) || !unpackRequestBodySchema.safeParse(message.body).success) return false
    const sentAt = receivedAt(message)
    return message.owner?._id?.equals(userMessage.owner) && sentAt >= windowStart && sentAt <= askedAt.getTime()
  })
  return earlierRequests.length >= UNPACK_REQUESTS_PER_MINUTE
}

async function findTranscriptChunks(conversationId, chunkIds: string[]): Promise<UnpackTranscriptChunk[] | null> {
  const uniqueIds = [...new Set(chunkIds)]
  if (!uniqueIds.every((id) => mongoose.isValidObjectId(id))) return null
  const chunks = await findMessages(
    conversationId,
    'model',
    { _id: { $in: uniqueIds }, ...TRANSCRIPT_TEXT_CHUNKS },
    { select: 'body createdAt', sort: { createdAt: 1, _id: 1 }, lean: true }
  )
  return chunks.length === uniqueIds.length ? chunks : null
}

// A catch-up is about what was said last, so the oldest chunks are the ones left out
function newestChunksThatFit(chunks: UnpackTranscriptChunk[]): UnpackTranscriptChunk[] {
  const kept: UnpackTranscriptChunk[] = []
  // Starts at -1 because the quote joins chunks with one space fewer than there are chunks
  let quoteLength = -1
  for (const chunk of [...chunks].reverse()) {
    quoteLength += chunk.body.length + 1
    if (quoteLength > UNPACK_CATCH_UP_MAX_CHARACTERS) break
    kept.unshift(chunk)
  }
  return kept
}

async function latestTranscriptEnd(conversationId, askedAt: Date): Promise<Date | null> {
  const [latest] = await findMessages(
    conversationId,
    'model',
    { ...TRANSCRIPT_TEXT_CHUNKS, createdAt: { $lte: askedAt } },
    { select: 'createdAt', sort: { createdAt: -1 }, limit: 1, lean: true }
  )
  return latest ? new Date(latest.createdAt) : null
}

/**
 * Asks the AI model for a catch-up summary of a few transcript chunks.
 * @param earlierSpeech - true when nothing in the transcript ended in the minute before the participant
 *   asked, so the summary must not present the chunks as just said
 */
export async function summarizeCatchUp(
  llm,
  {
    topic,
    chunks,
    earlierSpeech
  }: { topic: string; chunks: Pick<UnpackTranscriptChunk, 'body' | 'createdAt'>[]; earlierSpeech: boolean }
): Promise<CatchUpSummarySections> {
  const sections = await getChatPromptResponse(
    llm,
    CATCH_UP_SYSTEM_PROMPT,
    CATCH_UP_USER_TEMPLATE,
    {
      topic,
      timing: earlierSpeech ? EARLIER_SPEECH_TIMING : RECENT_SPEECH_TIMING,
      transcript: formatTranscript(chunks)
    },
    [],
    catchUpSummarySchema
  )
  return {
    inShort: sections.inShort,
    whatTheyCovered: sections.whatTheyCovered.slice(0, CATCH_UP_MAX_POINTS),
    comingUp: sections.comingUp?.trim() || null
  }
}

/**
 * Summarizes the transcript chunks a participant's browser picked for "Catch me up".
 * @param agent - the Event Assistant agent, with its conversation's messages and channels populated
 * @param userMessage - the participant's unpack_request message
 * @returns one reply for the participant's Private Chat, or nothing when the request should be ignored
 */
export default async function handleUnpackRequest(agent, userMessage): Promise<AgentResponse<unknown>[]> {
  const { conversation } = agent
  if (!isUnpackerEnabled(conversation)) return []

  const parsed = unpackRequestBodySchema.safeParse(userMessage.body)
  if (!parsed.success) {
    logger.warn(`unpack: ignoring malformed request ${userMessage._id}: ${parsed.error.message}`)
    return []
  }
  const request = parsed.data

  const channels: IChannel[] = conversation.channels.filter(
    (channel) => channel.direct && userMessage.channels?.includes(channel.name)
  )
  if (channels.length === 0) {
    logger.warn(`unpack: ignoring request ${userMessage._id} sent outside a Private Chat`)
    return []
  }

  // The job queue can lag, so time counts from when the participant asked, not now
  const askedAt = new Date(receivedAt(userMessage))
  if (isRateLimited(conversation, userMessage, askedAt)) return [refusal('rateLimited', userMessage, channels)]

  const latestEnd = await latestTranscriptEnd(conversation._id, askedAt)
  if (request.chunkIds.length === 0) {
    return [refusal(latestEnd ? 'noPassagesSent' : 'noTranscript', userMessage, channels)]
  }

  const namedChunks = await findTranscriptChunks(conversation._id, request.chunkIds)
  if (!namedChunks) {
    logger.warn(`unpack: request ${userMessage._id} named a chunk outside ${conversation._id}'s transcript`)
    return [refusal('chunkNotInTranscript', userMessage, channels)]
  }
  const chunks = newestChunksThatFit(namedChunks)
  if (chunks.length === 0) return [refusal('passageTooLong', userMessage, channels)]
  const quote = chunks.map((chunk) => chunk.body).join(' ')

  // A page that stopped updating can send old chunks while the speaker is still talking
  const earlierSpeech =
    latestEnd !== null && askedAt.getTime() - latestEnd.getTime() > UNPACK_LAST_MINUTE_WINDOW_SECONDS * 1000

  let sections: CatchUpSummarySections
  try {
    const llm = await getBedrockChat(config.unpackLLMModel, { maxTokens: CATCH_UP_MAX_OUTPUT_TOKENS })
    sections = await summarizeCatchUp(llm, { topic: conversation.name, chunks, earlierSpeech })
  } catch (error) {
    logger.error(`unpack: AI model call failed for request ${userMessage._id} in ${conversation._id}`, error)
    return [refusal('unpackFailed', userMessage, channels)]
  }

  const chunkIds = chunks.map((chunk) => chunk._id)
  const answerId = new mongoose.Types.ObjectId()

  const message: CatchUpSummary = {
    type: 'catch_up_summary',
    requestMessage: userMessage._id.toString(),
    chunkIds: chunkIds.map((id) => id.toString()),
    passage: {
      start: new Date(chunks[0].createdAt).toISOString(),
      end: new Date(chunks[chunks.length - 1].createdAt).toISOString()
    },
    earlierSpeech,
    ...sections,
    text: catchUpPlainText(sections, earlierSpeech)
  }

  // Written before the job saves the reply, so a failed reply save leaves answerMessage pointing at nothing
  let row
  try {
    row = await UnpackRequest.create({
      conversation: conversation._id,
      user: userMessage.owner,
      mode: request.mode,
      status: 'sent',
      destination: request.destination,
      chunkIds,
      quote,
      requestMessage: userMessage._id,
      answerMessage: answerId
    })
  } catch (error) {
    logger.error(`unpack: could not record request ${userMessage._id} in ${conversation._id}`, error)
  }

  // The transcript can be cleared during the AI call, after its cleanup already ran
  if (!(await chunksStillSaved(conversation._id, chunkIds))) {
    if (row) await UnpackRequest.deleteOne({ _id: row._id })
    return [refusal('chunkNotInTranscript', userMessage, channels)]
  }

  return [{ visible: true, message, messageType: 'json', channels, messageId: answerId }]
}
