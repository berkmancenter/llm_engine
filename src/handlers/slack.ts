import httpStatus from 'http-status'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import logger from '../config/logger.js'
import validateSignature from './helpers/validateSignature.js'
import findSlackAdapter from './helpers/findSlackAdapter.js'
import resolveSlackSigningSecret from './helpers/resolveSlackSigningSecret.js'
import webhookService from '../services/webhook.service.js'
import slackInteractionHandler from './slackInteraction.js'

// Slack retries webhook delivery if it doesn't get a 200 fast enough (common through ngrok).
// event_id stays the same on retries, so we track it to skip duplicates.
const DEDUP_WINDOW_MS = 5 * 60 * 1000 // 5 minutes — well beyond Slack's retry window
const seenEventIds = new Map<string, number>()

function isDuplicate(eventId: string): boolean {
  const now = Date.now()
  for (const [id, timestamp] of seenEventIds) {
    if (now - timestamp > DEDUP_WINDOW_MS) seenEventIds.delete(id)
  }
  if (seenEventIds.has(eventId)) return true
  seenEventIds.set(eventId, now)
  return false
}

const handleEvent = async (req, res) => {
  // Interactive component payloads (e.g. button clicks) arrive URL-encoded with the JSON
  // in a `payload` field, unlike Events API payloads which are raw JSON.
  if (typeof req.body.payload === 'string') {
    let parsed
    try {
      parsed = JSON.parse(req.body.payload)
    } catch {
      logger.warn('Slack interaction: received unparseable payload, ignoring')
      res.status(httpStatus.OK).send('ok')
      return
    }
    if (parsed.type === 'block_actions') {
      await slackInteractionHandler.receiveInteraction(parsed)
    }
    // Always respond 200 — Slack requires a fast acknowledgment and does not retry on non-200
    // for interactive components.
    res.status(httpStatus.OK).send('ok')
    return
  }

  const payload = req.body

  // Handle Slack URL verification
  if (payload.type === 'url_verification') {
    res.status(httpStatus.OK).send(payload.challenge)
    return
  }
  const eventId = payload.event_id
  if (eventId && isDuplicate(eventId)) {
    logger.debug(`Slack duplicate event skipped: ${eventId}`)
    res.status(httpStatus.OK).send('ok')
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
    // TODO limit same Slack channel to one active Conversation
    // The middleware already looked up the bot when it validated the signature, so reuse it.
    const slackAdapter = req.slackAdapter ?? (await findSlackAdapter({ appKey: req.params?.appKey, payload }))
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

    // To validate against a specific bot's secret, the request first has to identify the bot:
    // either the URL carries a bot identifier, or the body has an event payload with a workspace
    // ID to look it up by. URL verification and button-click payloads have neither, so they fall
    // back to the global env-var secret.
    const appKey: string | undefined = req.params?.appKey
    // Slack's API still calls workspaces "teams", so `event.team` is the workspace ID.
    const slackWorkspaceId: string | undefined = req.body?.event?.team
    const canIdentifyAdapter = Boolean(appKey || slackWorkspaceId)

    if (!canIdentifyAdapter) {
      const isValid = validateSignature(slackTimestamp, rawBody, slackSignature, config.slack.signingSecret)
      if (!isValid) {
        throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
      }
      next()
      return
    }

    const slackAdapter = await findSlackAdapter({ appKey, payload: req.body })
    if (!slackAdapter) {
      // Stay deliberately vague: don't reveal whether the adapter is missing or the signature is bad.
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
    }

    const isValid = validateSignature(slackTimestamp, rawBody, slackSignature, resolveSlackSigningSecret(slackAdapter))
    if (!isValid) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
    }

    req.slackAdapter = slackAdapter
    next()
  } catch (err) {
    next(err)
  }
}
export default { handleEvent, middleware }
