import mongoose from 'mongoose'
import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import PLAIN_LANGUAGE_TERM_RULES from '../helpers/plainLanguageRules.js'
import UnpackRequest from '../../models/unpackRequest.model.js'
import logger from '../../config/logger.js'
import { AgentResponse, IChannel, UNPACK_DESTINATIONS, UNPACK_MODES, UnpackExplanation } from '../../types/index.types.js'

// Transcript chunks only store when the speaker finished, so this counts chunks that ended in the window
export const UNPACK_LAST_MINUTE_WINDOW_SECONDS = 60
// Each request is one AI model call, so this caps what one participant can spend
export const UNPACK_REQUESTS_PER_MINUTE = 3

export const UNPACK_REPLIES = {
  noTranscript:
    "I didn't catch any of the talk in the last minute, so there's nothing to unpack yet. Try again once the speaker has said a bit more.",
  rateLimited: "Let's give the speaker a little time to say more. Ask me again in a minute and I'll unpack what's new.",
  failed: "Sorry, I couldn't unpack that just now. Please try again in a moment."
}

export const UNPACK_SYSTEM_PROMPT = `You help a participant at a live event follow what the speaker just said. You get the event topic and a short passage of the live transcript. Transcription is automatic, so expect missing words and misheard terms, and work out what the speaker most likely meant.

Write three things:
- whatTheyreSaying: two or three sentences restating the passage in plain language.
- whyItMatters: one or two sentences on how the passage connects to the event topic or the speaker's larger point.
- terms: specialist terms, acronyms, or named concepts from the passage that a general audience would not know, each with a one or two sentence explanation. Use an empty list when there are none. Skip common words and the names of people, companies, and products.

Only explain what is in the passage. Don't add claims the speaker didn't make, and don't guess what comes next.

## Writing rules
${PLAIN_LANGUAGE_TERM_RULES}`

const UNPACK_USER_TEMPLATE = `## Event topic:
{topic}

## Transcript passage:
{transcript}`

const unpackRequestBodySchema = z.object({
  type: z.literal('unpack_request'),
  mode: z.enum(UNPACK_MODES),
  text: z.string(),
  destination: z.enum(UNPACK_DESTINATIONS).default('privateChat')
})

const unpackExplanationSchema = z.object({
  whatTheyreSaying: z.string(),
  whyItMatters: z.string(),
  terms: z.array(z.object({ term: z.string(), text: z.string() }))
})

export function isUnpackRequest(message): boolean {
  return message?.bodyType === 'json' && message?.body?.type === 'unpack_request'
}

// An event saved before the switch existed has no entry for it, which means off
function isUnpackerEnabled(conversation): boolean {
  const feature = conversation.features?.find((f) => f.name === 'unpacker')
  return feature ? feature.enabled !== false : false
}

function textReply(text: string, channels: IChannel[]): AgentResponse<string> {
  return { visible: true, message: text, messageType: 'text', channels }
}

function toPlainText({ whatTheyreSaying, whyItMatters, terms }: z.infer<typeof unpackExplanationSchema>): string {
  const sections = [`What they're saying: ${whatTheyreSaying}`, `Why it matters here: ${whyItMatters}`]
  if (terms.length > 0) {
    sections.push(`Terms in this passage:\n${terms.map(({ term, text }) => `- ${term}: ${text}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

function getTranscriptWindow(conversation, end: Date) {
  const start = end.getTime() - UNPACK_LAST_MINUTE_WINDOW_SECONDS * 1000
  return (conversation.messages ?? [])
    .filter((message) => {
      const finishedAt = new Date(message.createdAt).getTime()
      return message.channels?.includes('transcript') && finishedAt >= start && finishedAt <= end.getTime()
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

async function isRateLimited(conversationId, userId): Promise<boolean> {
  const recentRequests = await UnpackRequest.countDocuments({
    conversation: conversationId,
    user: userId,
    createdAt: { $gte: new Date(Date.now() - 60 * 1000) }
  })
  return recentRequests >= UNPACK_REQUESTS_PER_MINUTE
}

/**
 * Explains a recent passage of the talk for the participant who asked.
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

  // The job queue can lag, so the window ends when the participant asked, not now
  const askedAt = userMessage.createdAt ? new Date(userMessage.createdAt) : new Date()
  const chunks = getTranscriptWindow(conversation, askedAt)
  if (chunks.length === 0) return [textReply(UNPACK_REPLIES.noTranscript, channels)]

  if (await isRateLimited(conversation._id, userMessage.owner)) {
    return [textReply(UNPACK_REPLIES.rateLimited, channels)]
  }

  let sections: z.infer<typeof unpackExplanationSchema>
  try {
    const llm = await agent.getLLM()
    sections = await getChatPromptResponse(
      llm,
      UNPACK_SYSTEM_PROMPT,
      UNPACK_USER_TEMPLATE,
      { topic: conversation.name, transcript: formatTranscript(chunks) },
      [],
      unpackExplanationSchema
    )
  } catch (error) {
    logger.error(`unpack: AI model call failed for request ${userMessage._id} in ${conversation._id}`, error)
    return [textReply(UNPACK_REPLIES.failed, channels)]
  }

  const chunkIds = chunks.map((chunk) => chunk._id)
  const quote = chunks.map((chunk) => chunk.body).join(' ')
  const answerId = new mongoose.Types.ObjectId()

  const message: UnpackExplanation = {
    type: 'unpack_explanation',
    mode: request.mode,
    destination: request.destination,
    requestMessage: userMessage._id.toString(),
    chunkIds: chunkIds.map((id) => id.toString()),
    passage: {
      start: new Date(chunks[0].createdAt).toISOString(),
      end: new Date(chunks[chunks.length - 1].createdAt).toISOString()
    },
    quote,
    ...sections,
    text: toPlainText(sections)
  }

  await UnpackRequest.create({
    conversation: conversation._id,
    user: userMessage.owner,
    mode: request.mode,
    destination: request.destination,
    chunkIds,
    quote,
    requestMessage: userMessage._id,
    answerMessage: answerId
  })

  return [{ visible: true, message, messageType: 'json', channels, messageId: answerId }]
}
