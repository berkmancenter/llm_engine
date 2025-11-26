import httpStatus from 'http-status'
import ApiError from '../../utils/ApiError.js'
import Adapter from '../../models/adapter.model.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import validateSignature from '../helpers/validateSignature.js'
import webhookService from '../../services/webhook.service.js'

const handleEvent = async (req, res) => {
  const payload = req.body

  // Handle Slack URL verification
  if (payload.type === 'url_verification') {
    res.status(httpStatus.OK).send(payload.challenge)
    return
  }
  const { event } = payload
  if (!event) {
    logger.info(`Received payload from Slack without an event: ${payload}`)
    res.status(httpStatus.OK).send('ok')
    return
  }
  // Skip bot messages to prevent loops and skip messages with subtypes, which are not user messages (they represent events like user joining a channel, etc)
  if (event.type === 'message' && !event.bot_id && !event.subtype) {
    let slackAdapter
    // TODO limit same Slack channel to one active Conversation
    if (event.channel_type === 'im') {
      // Only one Conversation can process Slack DMs, since they are not related to a specific "conversation" or "channel"
      slackAdapter = await Adapter.findOne({
        type: 'slack',
        'config.channel': 'direct',
        'config.workspace': event.team
      })
    } else {
      slackAdapter = await Adapter.findOne({
        type: 'slack',
        'config.channel': event.channel,
        'config.workspace': event.team
      })
    }
    if (!slackAdapter) {
      throw new ApiError(
        httpStatus.NOT_FOUND,
        `Slack adapter for workspace ${event.team} and channel ${event.channel} not found`
      )
    }
    await webhookService.receiveMessage(slackAdapter, event)
  }
  res.status(httpStatus.OK).send('ok')
}

const middleware = async (req, res, next) => {
  try {
    const slackSignature = req.headers['x-slack-signature']
    const slackTimestamp = req.headers['x-slack-request-timestamp']

    if (!slackSignature) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Missing slack signature header')
    }
    if (!slackTimestamp) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Missing slack timestamp header')
    }

    // Have to access the raw body before JSON deserialization
    const { rawBody } = req
    if (!rawBody) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Raw body missing')
    }
    const isValid = validateSignature(slackTimestamp, rawBody, slackSignature, config.slack.signingSecret)

    if (!isValid) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
    }
    next()
  } catch (err) {
    next(err)
  }
}
export default { handleEvent, middleware }
