import httpStatus from 'http-status'
import crypto from 'crypto'
import { Buffer } from 'buffer'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import logger from '../config/logger.js'
import Conversation from '../models/conversation.model.js'
import Adapter from '../models/adapter.model.js'
import webhookService from '../services/webhook.service.js'
import transcriptService from '../services/transcript.service.js'

const verifyRequestFromRecall = (args: { secret: string; headers: Record<string, string>; payload: string | null }) => {
  const { secret, headers, payload } = args
  const msgId = headers['webhook-id'] ?? headers['svix-id']
  const msgTimestamp = headers['webhook-timestamp'] ?? headers['svix-timestamp']
  const msgSignature = headers['webhook-signature'] ?? headers['svix-signature']

  if (!secret || !secret.startsWith('whsec_')) {
    throw new Error(`Verification secret (${secret}) is missing or invalid`)
  }
  if (!msgId || !msgTimestamp || !msgSignature) {
    throw new Error(`Missing webhook ID (${msgId}), timestamp (${msgTimestamp}), or signature (${msgSignature})`)
  }

  const prefix = 'whsec_'
  const base64Part = secret.startsWith(prefix) ? secret.slice(prefix.length) : secret
  const key = Buffer.from(base64Part, 'base64')

  let payloadStr = ''
  if (payload) {
    if (Buffer.isBuffer(payload)) {
      payloadStr = payload.toString('utf8')
    } else if (typeof payload === 'string') {
      payloadStr = payload
    }
  }

  const toSign = `${msgId}.${msgTimestamp}.${payloadStr}`
  const expectedSig = crypto.createHmac('sha256', key).update(toSign).digest('base64')

  const passedSigs = msgSignature.split(' ')
  for (const versionedSig of passedSigs) {
    const [version, signature] = versionedSig.split(',')
    if (version !== 'v1') {
      continue
    }
    const sigBytes = Buffer.from(signature, 'base64')
    const expectedSigBytes = Buffer.from(expectedSig, 'base64')
    if (
      expectedSigBytes.length === sigBytes.length &&
      crypto.timingSafeEqual(new Uint8Array(expectedSigBytes), new Uint8Array(sigBytes))
    ) {
      return
    }
  }

  throw new Error('No matching signature found')
}

const handleBotStatusChange = async (adapter, body) => {
  const { code, sub_code: subCode, message } = body.data.data
  logger.info(`Bot status changed for adapter ${adapter._id}: ${code}${subCode ? ` (${subCode})` : ''} - ${message}`)

  const { conversation } = adapter
  if (!conversation.active) {
    logger.info('Conversation is not active. Skipping bot status change handling.')
    return
  }
  const wasPaused = conversation.transcript?.status !== 'active'
  // Handle bot resuming recording
  if (code === 'in_call_recording') {
    if (wasPaused) {
      await transcriptService.updateTranscriptStatus(conversation, 'active')
      logger.info(`Bot resumed recording for adapter ${adapter._id}`)
    }
    return
  }

  // Handle paused recording
  if (code === 'in_call_not_recording') {
    if (!wasPaused) {
      await transcriptService.updateTranscriptStatus(conversation, 'paused')
      logger.info(`Bot paused recording for adapter ${adapter._id}`)
    }
    return
  }

  // Update transcript status if it was active
  if (!wasPaused) {
    await transcriptService.stopTranscript(conversation)
  }

  // Handle bot stopping/leaving (call_ended with specific sub_codes)
  const stoppedSubCodes = [
    'bot_received_leave_call',
    'timeout_exceeded_noone_joined',
    'timeout_exceeded_in_call_not_recording',
    'timeout_exceeded_max_duration'
  ]

  if (code === 'call_ended' && subCode && stoppedSubCodes.includes(subCode)) {
    // Attempt to redeploy the bot
    logger.warn(`Bot left call but meeting still active (${subCode}). Attempting to redeploy...`)
    try {
      await adapter.start()
      logger.info(`Successfully redeployed bot for adapter ${adapter._id}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logger.error(`Failed to redeploy bot for adapter ${adapter._id}: ${errorMessage}`)
    }
  }
}

const supportedEvents = [
  'transcript.data',
  'participant_events.chat_message',
  'participant_events.join',
  'bot.call_ended',
  'bot.in_call_recording',
  'bot.in_call_not_recording'
]
const handleEvent = async (req, _res) => {
  const { event } = req.body
  if (!supportedEvents.includes(event)) {
    logger.warn(`Received unsupported event type: ${event}`)
    _res.status(httpStatus.OK).send('ok')
    return
  }

  const botId = req.body.data?.bot?.id

  // These events come from dashboard webhooks (not realtime endpoints)
  // so we need to search for the adapter by botId across all conversations
  if (event === 'bot.call_ended' || event === 'bot.in_call_recording' || event === 'bot.in_call_not_recording') {
    const zoomAdapter = await Adapter.findOne({ type: 'zoom', 'config.botId': botId }).populate('conversation').exec()
    if (!zoomAdapter) {
      logger.warn(`Received bot.status_change for unknown botId ${botId}`)
      _res.status(httpStatus.OK).send('ok')
      return
    }
    await handleBotStatusChange(zoomAdapter, req.body)
    _res.status(httpStatus.OK).send('ok')
    return
  }

  // For other events, use conversationId from query params
  const { conversationId } = req.query
  const conversation = await Conversation.findOne({ _id: conversationId }).populate('adapters').exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }
  const zoomAdapter = conversation.adapters?.find((adapter) => adapter.type === 'zoom' && adapter.config.botId === botId)
  if (!zoomAdapter) {
    throw new ApiError(httpStatus.NOT_FOUND, `No Zoom adapter with botId ${botId} configured for this conversation`)
  }
  if (event === 'transcript.data' || event === 'participant_events.chat_message') {
    await webhookService.receiveMessage(zoomAdapter, req.body)
  } else if (event === 'participant_events.join') {
    await webhookService.participantJoined(zoomAdapter, req.body.data.data.participant)
  }
  _res.status(httpStatus.OK).send('ok')
}

const middleware = async (req, _res, next) => {
  try {
    // Calculate headers first
    const headers: Record<string, string> = {}
    Object.keys(req.headers).forEach((key) => {
      const value = req.headers[key]
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value
      }
    })

    // Determine which secret to use based on the presence of Svix headers
    const isSvixWebhook = !!headers['svix-id']
    const secret = isSvixWebhook ? config.recall.svixSecret : config.recall.realtimeSecret

    // Use raw body captured by body-parser verify function
    const payload = req.rawBody || null

    try {
      verifyRequestFromRecall({ secret, headers, payload })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logger.warn(`Recall webhook verification failed: ${errorMessage}`)
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid webhook signature')
    }

    next()
  } catch (err) {
    next(err)
  }
}

export default { middleware, handleEvent }
