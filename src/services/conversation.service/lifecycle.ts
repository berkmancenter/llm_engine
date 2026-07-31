import httpStatus from 'http-status'
import { traceable } from 'langsmith/traceable'
import config from '../../config/config.js'
import ApiError from '../../utils/ApiError.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import agentService from '../agent.service/index.js'
import agentDispatcher from '../../jobs/agentDispatcher.js'
import schedule from '../../jobs/schedule.js'
import defineJob from '../../jobs/define.js'
import logger from '../../config/logger.js'
import adapterService from '../adapter.service.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import { coreLLMModel, coreLLMPlatform, getModelChat } from '../../agents/helpers/getModelChat.js'
import { Conversation, User } from '../../models/index.js'
import { formatTranscript, formatMultiUserConversationHistory } from '../../agents/helpers/llmInputFormatters.js'
import getConversationHistory from '../../agents/helpers/getConversationHistory.js'
import Poll from '../../models/poll.model/poll.js'
import { getConversationType } from '../../conversations/index.js'
import { isValidPropertyFormat } from '../../conversations/propertyFormats.js'

const transcriptBatchInterval = 30
const SUMMARIZATION_PROMPT = `
  Please summarize what happened during this conversation. Where possible, also draw conclusions about outcomes of the discussion.
  When available, use as reference the listed speaker(s), moderator(s) and their bios, and event description.

  - **IMPORTANT**: you are summarizing for the event attendees. You are not worried about things like engagement or metrics. You want to provide a clear and concise summary of the key points and outcomes in a digestible format.
  - **FORMAT**: use exactly these three sections, each with a bold heading on its own line (not inside a bullet):
    - **The Gist** — 2-4 sentences covering the core topic and key takeaway.
    - **Highlights** — exactly 3 bullets with the most important facts, perspectives, or conclusions drawn from the event. Keep each bullet to one sentence.
    - **The Breakdown** — 3-5 bullets listing the main topics or segments covered, in order. One sentence each, no sub-bullets.
  - The tone is friendly and conversational.
  - The event content will be made up of a transcript as well as participant messages.
  - The transcript is drawing from what was said by the speakers in the event, or in some cases might be a video presentation of some kind. Be aware that speakers are generally allowed to use whatever media they would like during the conversation.
  - The participant messages are from attendees in a group chat either on Zoom or within a custom-built front-end app. Messages labelled "AI Assistant" are from automated assistants — ignore them entirely, do not mention or attribute them.
  - Only include a section about group chat if there were meaningful participant contributions. If the chat was empty or contained only AI Assistant messages, omit it entirely.`

export const updateTranscriptStatus = async (
  conversation,
  status: 'active' | 'paused' | 'stopped' | 'deleted'
): Promise<void> => {
  const doc = conversation
  if (!doc.transcript) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No transcript configured for this conversation')
  }
  if (doc.transcript.status === status) {
    logger.debug(`Transcript already in status ${status} for conversation ${doc._id}`)
    return
  }

  doc.transcript.status = status
  await doc.save()
  await websocketGateway.broadcastTranscriptStatusChange(conversation, status)
  logger.info(`Transcript ${status} for conversation ${conversation._id}`)
}

async function scheduleTranscriptBatching(conversation) {
  await schedule.cancelBatchTranscript(conversation._id)
  await defineJob.batchTranscript(conversation._id)
  await schedule.batchTranscript(`${transcriptBatchInterval} seconds`, { conversationId: conversation._id })
}

/**
 * A conversation-like object with just the fields needed to determine draft status. Accepts
 * either a Mongoose document or a plain object being assembled before the first save.
 */
export interface DraftStatusInput {
  name?: string
  topic?: unknown
  conversationType?: string
  scheduledTime?: Date | string | null
  scheduledEndTime?: Date | string | null
  properties?: Record<string, unknown>
}

/**
 * Whether the conversation satisfies every property rule its type declares: each required
 * property is present (a declared default counts, matching how resolveConversationType fills
 * them), and each present property with a `format` passes it. Rules come from the type
 * definition, so this stays correct as types change rather than naming any property here.
 * The same format validators back resolver.validateProperties, so the two paths agree.
 */
export function satisfiesTypeProperties(conversation: DraftStatusInput): boolean {
  const type = conversation.conversationType ? getConversationType(conversation.conversationType) : undefined
  const propertyDefs = type?.properties ?? []
  return propertyDefs.every((property) => {
    const value = conversation.properties?.[property.name] ?? property.default
    if (property.required && (value === undefined || value === null || value === '')) return false
    if (property.format && value !== undefined && value !== null && !isValidPropertyFormat(property.format, value)) {
      return false
    }
    return true
  })
}

/**
 * A conversation is Draft until everything needed to run it as a scheduled event is present
 * and valid. Conversations with no scheduledTime are instant-start (the existing nextspace
 * "create and start now" flow, not a calendar-invite event awaiting completion) and are never
 * Draft as long as they have a name and a topic, both already schema-required. Scheduled
 * conversations additionally need an end time and every property rule their type declares,
 * including format rules such as the Zoom-host check.
 */
export function isConversationDraft(conversation: DraftStatusInput): boolean {
  const hasName = typeof conversation.name === 'string' && conversation.name.trim().length > 0
  const hasTopic = !!conversation.topic

  if (!conversation.scheduledTime) {
    return !hasName || !hasTopic
  }

  if (!hasName || !hasTopic || !conversation.scheduledEndTime) return true
  return !satisfiesTypeProperties(conversation)
}

export async function doStartConversation(conversation) {
  const doc = conversation
  if (doc.draft) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot start a draft conversation until required fields are filled in.')
  }
  logger.debug(`Start conversation: ${doc._id}`)
  doc.startTime = new Date()
  for (const agent of doc.agents) {
    // needed so agent has all conversation info for activation
    agent.conversation = doc
    await agentService.startAgent(agent)
  }
  await scheduleTranscriptBatching(doc)
  for (const adapter of doc.adapters) {
    adapter.conversation = doc
    await adapterService.start(adapter)
  }
  doc.active = true
  await doc.save()
  return doc
}

export async function doStopConversation(conversation) {
  const doc = conversation
  logger.debug(`Stop conversation: ${doc._id}`)
  doc.endTime = new Date()
  for (const agent of doc.agents) {
    // needed so agent has all conversation info for activation
    agent.conversation = doc
    await agentService.stopAgent(agent)
  }
  await schedule.cancelBatchTranscript(doc._id)
  const activePolls = await Poll.find({ conversation: doc._id, expirationDate: { $gt: new Date() } }, '_id')
  await Promise.all(activePolls.map((poll) => schedule.cancelPollExpired(poll._id.toString())))
  for (const adapter of doc.adapters) {
    adapter.conversation = doc
    await adapterService.stop(adapter)
  }
  doc.active = false

  if (doc.transcript) {
    await updateTranscriptStatus(doc, 'stopped')
    const owner = await User.findById(conversation.owner)

    if (owner) {
      const conversationDoc = await Conversation.findOne({ _id: conversation._id })
        .populate('channels')
        .populate({ path: 'messages', match: { channels: { $in: ['transcript', 'chat'] } } })

      if (conversationDoc) {
        const llm = await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 2000 })
        const sortedMessages = conversationDoc.messages.sort(
          (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
        )
        const transcriptMessages = sortedMessages.filter((m) => m.channels?.includes('transcript'))
        const transcript = formatTranscript(transcriptMessages, 'UTC')

        const chatHistory = getConversationHistory(sortedMessages, { channels: ['chat'] })
        const sharedChat =
          formatMultiUserConversationHistory(chatHistory)
            .map((m) => (m.role === 'assistant' ? `AI Assistant: ${m.content}` : m.content))
            .join('\n') || 'No participant chat messages.'

        // Get speaker and moderator information if available
        const speakers = `${conversationDoc.presenters?.map((p) => `${p.name}: ${p.bio}`).join(', ')}` || 'Not provided'
        const moderators = `${conversationDoc.moderators?.map((m) => `${m.name}: ${m.bio}`).join(', ')}` || 'Not provided'
        const eventDescription = conversationDoc.description || 'Not provided'

        /* Tagged like agent traces (conversationId + costPhase: 'postEvent') so
           numberCruncher's cost fetcher attributes this call to the conversation it
           summarizes, grouped with other post-stop spend rather than the live event. */
        const structuredSummary = await traceable(
          async () =>
            getChatPromptResponse(
              llm,
              SUMMARIZATION_PROMPT,
              `
            Event Transcript: {transcript},
            Shared Chat: {sharedChat},
            Speaker(s): {speakers},
            Moderator(s): {moderators},
            Event Description: {eventDescription}
          `,
              { transcript, sharedChat, speakers, moderators, eventDescription }
            ),
          { name: 'conversationSummary', metadata: { conversationId: doc._id.toString(), costPhase: 'postEvent' as const } }
        )()

        logger.debug(`Conversation summary generated for conversation ${doc._id}`)

        doc.summary = structuredSummary
      } else logger.warn(`No conversation document found for conversation ${doc._id}`)
    } else logger.warn(`No owner found for conversation ${doc._id}`)
  }
  await doc.save()

  /* External analytics (e.g. Matomo tracked sessions) are intentionally NOT fetched
     here. The provider may not have archived the just-ended event's visits yet, and
     stopping the event must stay fast and not block on a slow or cold archive. The
     Vibes Analyst pulls and stores that snapshot from its own dispatched job below,
     where it can retry patiently off this request path. */
  const topicId = doc.topic?._id?.toString() ?? doc.topic?.toString()
  const topicIsPrivate = doc.topic?.private ?? true
  await agentDispatcher.dispatch(
    { type: 'conversationStopped', conversationId: doc._id.toString(), topicId },
    { type: 'conversation', id: doc._id.toString(), topicId, topicIsPrivate }
  )

  /* Cost tracking must not depend on Number Cruncher being provisioned (a separate
     Slack bot + admin conversation) — it's core functionality for every conversation,
     public or private, gated only by this flag. See jobs/handlers/conversationCost.ts:
     it steps aside if an active Number Cruncher agent is already handling this event. */
  if (config.enableConversationCostTracking) {
    await schedule.conversationCost({ conversationId: doc._id.toString(), topicIsPrivate })
  }

  return doc
}

export async function doConversationEndingSoon(conversation) {
  await conversation.populate(['topic', 'agents', 'adapters'])

  await websocketGateway.broadcastConversationAlmostEnding(conversation)
}
