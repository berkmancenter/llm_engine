import httpStatus from 'http-status'
import crypto from 'crypto'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import logger from '../config/logger.js'
import Conversation from '../models/conversation.model.js'
import webhookService from '../services/webhook.service.js'

const supportedEvents = ['transcript.data', 'participant_events.chat_message', 'participant_events.join']
const handleEvent = async (req, res) => {
  const { event } = req.body
  if (!supportedEvents.includes(event)) {
    logger.warn(`Received unsupported event type: ${event}`)
    res.status(httpStatus.OK).send('ok')
    return
  }
  const { conversationId } = req.query
  const conversation = await Conversation.findOne({ _id: conversationId }).populate('adapters').exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }
  const botId = req.body.data.bot.id
  const zoomAdapter = conversation.adapters?.find((adapter) => adapter.type === 'zoom' && adapter.config.botId === botId)
  if (!zoomAdapter) {
    throw new ApiError(httpStatus.NOT_FOUND, `No Zoom adapter with botId ${botId} configured for this conversation`)
  }
  if (event === 'transcript.data' || event === 'participant_events.chat_message') {
    await webhookService.receiveMessage(zoomAdapter, req.body)
  } else {
    await webhookService.participantJoined(zoomAdapter, req.body.data.data.participant)
  }
  res.status(httpStatus.OK).send('ok')
}

const middleware = async (req, res, next) => {
  try {
    const { token } = req.query
    if (!token) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Token not provided')
    }
    const providedBuffer = Buffer.from(token)
    const secretBuffer = Buffer.from(config.recall.token)
    if (providedBuffer.length !== secretBuffer.length) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token')
    }
    if (!crypto.timingSafeEqual(providedBuffer, secretBuffer)) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid token')
    }
    next()
  } catch (err) {
    next(err)
  }
}

export default { middleware, handleEvent }
