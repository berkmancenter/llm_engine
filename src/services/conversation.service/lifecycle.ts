import httpStatus from 'http-status'
import ApiError from '../../utils/ApiError.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import agentService from '../agent.service/index.js'
import schedule from '../../jobs/schedule.js'
import defineJob from '../../jobs/define.js'
import logger from '../../config/logger.js'
import adapterService from '../adapter.service.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import { coreLLMModel, coreLLMPlatform, getModelChat } from '../../agents/helpers/getModelChat.js'
import { User } from '../../models/index.js'
import { conversationService, messageService, transcriptService } from '../index.js'

const transcriptBatchInterval = 30
const SUMMARIZATION_PROMPT = `Please summarize what happened during this conversation. Where possible, also draw conclusions about outcomes of the discussion. 
  
  - The event content will be made up of a transcript as well as participant messages. 
  - The transcript is drawing from what was said by the speakers in the event, or in some cases might be a video presentation of some kind. Be aware that speakers are generally allowed to use whatever media they would like during the conversation.
  - The participant messages are from attendees in a group chat either on Zoom or within a custom-built front-end app.`

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
    const owner = await User.findById(conversation.owner)
    const conversationDoc = await conversationService.findByIdFull(doc._id, owner)

    await updateTranscriptStatus(doc, 'stopped')

    const llm = await getModelChat(coreLLMPlatform, coreLLMModel)
    // Get transcript and participant messages
    const transcript = await transcriptService.getPlainTextTranscript(doc._id)
    const participantMessages = await messageService.conversationMessages(
      doc._id,
      [
        {
          name: 'chat',
          passcode: (conversationDoc.channels.find((c) => c.name === 'chat') ?? { passcode: undefined })?.passcode
        }
      ],
      owner
    )
    const structured = await getChatPromptResponse(
      llm,
      SUMMARIZATION_PROMPT,
      `Event Transcript: {transcript}, Participant Messages: {participantMessages}`,
      { transcript, participantMessages }
    )

    logger.debug(`Conversation summary generated for conversation ${doc._id}`)

    doc.summary = structured
  }
  await doc.save()
  return doc
}
