import httpStatus from 'http-status'
import { Adapter, Conversation } from '../models/index.js'
import logger from '../config/logger.js'
import validateSignature from './helpers/validateSignature.js'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import { conversationService } from '../services/index.js'
import { maxScheduledInterval } from '../services/adapter.service.js'

async function findConversations(meetingId, activeOnly) {
  const zoomAdapters = await Adapter.find({
    'config.meetingUrl': { $regex: meetingId, $options: 'i' },
    type: 'zoom'
  })
  // Extract the adapter IDs
  const adapterIds = zoomAdapters.map((adapter) => adapter._id)
  if (adapterIds.length === 0) {
    return []
  }
  // Find conversations that reference any of these adapters
  const conversations = await Conversation.find({
    adapters: { $in: adapterIds },
    ...(activeOnly === true && { active: true })
  })
  return conversations
}

const handleEvent = async (req, res) => {
  const { event, payload } = req.body
  if (event === 'meeting.started' || event === 'meeting.ended') {
    const activeConvosOnly = event === 'meeting.ended'
    let conversations = await findConversations(payload.object.id, activeConvosOnly)
    if (conversations.length === 0) {
      logger.warn(`Received ${event} event but no Zoom adapter found for meeting with ID: ${payload.object.id}`)
      res.status(httpStatus.OK).send('ok')
      return
    }
    if (event === 'meeting.started') {
      // If more than one conversation, attempt to narrow by scheduled time
      if (conversations.length > 1) {
        conversations = conversations.filter((conversation) => {
          // Skip conversations without scheduledTime
          if (!conversation.scheduledTime) {
            return false
          }
          const scheduledTime = new Date(conversation.scheduledTime)
          const timeDifference = Math.abs(scheduledTime.getTime() - new Date(payload.object.start_time).getTime())
          return timeDifference <= maxScheduledInterval
        })
        if (conversations.length !== 1) {
          logger.error(
            `Unable to process zoom ${event} event. ${conversations.length} conversations matching the scheduled time window found with meeting ID ${payload.object.id}`
          )
          res.status(httpStatus.OK).send('ok')
          return
        }
      }
      logger.debug(`Starting conversation ${conversations[0]._id} on Zoom meeting started event`)
      await conversationService.startConversation(conversations[0], conversations[0].owner)
    } else {
      // Stop all active conversations with this Zoom meeting ID
      for (const conversation of conversations) {
        logger.debug(`Stopping conversation ${conversation._id} on Zoom meeting ended event`)
        await conversationService.stopConversation(conversation, conversation.owner)
      }
    }
  }
  res.status(httpStatus.OK).send('ok')
}

const middleware = async (req, res, next) => {
  try {
    const zoomSignature = req.headers['x-zm-signature']
    const zoomTimestamp = req.headers['x-zm-request-timestamp']

    if (!zoomSignature || !zoomTimestamp) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Missing Zoom signature headers')
    }
    const { rawBody } = req
    if (!rawBody) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Raw body missing')
    }
    const isValid = validateSignature(zoomTimestamp, rawBody, zoomSignature, config.zoom.secretToken)
    if (!isValid) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Zoom signature')
    }
    next()
  } catch (err) {
    next(err)
  }
}

export default { middleware, handleEvent }
