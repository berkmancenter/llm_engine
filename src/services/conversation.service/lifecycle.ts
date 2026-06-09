import httpStatus from 'http-status'
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

const transcriptBatchInterval = 30
const SUMMARIZATION_PROMPT = `
  Please summarize what happened during this conversation. Where possible, also draw conclusions about outcomes of the discussion. 
  When available, use as reference the listed speaker(s), moderator(s) and their bios, and event description.

  - **IMPORTANT**: you are summarizing for the event attendees. You are not worried about things like engagement or metrics. You want to provide a clear and concise summary of the key points and outcomes in a digestible format.
  - **LENGTH**: write no more than three paragraphs. Be selective — prioritize the most significant points and outcomes over completeness.
  - The tone is friendly and conversational.
  - The event content will be made up of a transcript as well as participant messages. 
  - The transcript is drawing from what was said by the speakers in the event, or in some cases might be a video presentation of some kind. Be aware that speakers are generally allowed to use whatever media they would like during the conversation.
  - The participant messages are from attendees in a group chat either on Zoom or within a custom-built front-end app.
  - Participants might want to know what other participants were saying relative to the event wrap-up.`

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

export async function doStartConversation(conversation) {
  const doc = conversation
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
            .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
            .join('\n') || 'No shared chat messages yet.'

        // Get speaker and moderator information if available
        const speakers = `${conversationDoc.presenters?.map((p) => `${p.name}: ${p.bio}`).join(', ')}` || 'Not provided'
        const moderators = `${conversationDoc.moderators?.map((m) => `${m.name}: ${m.bio}`).join(', ')}` || 'Not provided'
        const eventDescription = conversationDoc.description || 'Not provided'

        const structuredSummary = await getChatPromptResponse(
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
        )

        logger.debug(`Conversation summary generated for conversation ${doc._id}`)

        doc.summary = structuredSummary
      } else logger.warn(`No conversation document found for conversation ${doc._id}`)
    } else logger.warn(`No owner found for conversation ${doc._id}`)
  }
  await doc.save()

  const topicId = doc.topic?._id?.toString() ?? doc.topic?.toString()
  const topicIsPrivate = doc.topic?.private ?? true
  await agentDispatcher.dispatch(
    { type: 'conversationStopped', conversationId: doc._id.toString(), topicId },
    { type: 'conversation', id: doc._id.toString(), topicId, topicIsPrivate }
  )

  return doc
}
