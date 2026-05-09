import httpStatus from 'http-status'
import ApiError from '../../utils/ApiError.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import agentService from '../agent.service/index.js'
import schedule from '../../jobs/schedule.js'
import defineJob from '../../jobs/define.js'
import logger from '../../config/logger.js'
import adapterService from '../adapter.service.js'

const transcriptBatchInterval = 30

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
  }
  await doc.save()
  return doc
}
