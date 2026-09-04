import httpStatus from 'http-status'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import logger from '../config/logger.js'
import validateSignature from './helpers/validateSignature.js'
import findSlackAdapter, { findSlackAppHomeTarget } from './helpers/findSlackAdapter.js'
import resolveSlackSigningSecret from './helpers/resolveSlackSigningSecret.js'
import webhookService from '../services/webhook.service.js'
import slackInteractionHandler from './slackInteraction.js'
import buildAppHomeData from '../agents/communityAssistant/appHomeContent.js'
import renderAppHomePage from '../adapters/slack/blocks/communityAssistant/appHome.js'
import { publishHomeView } from '../adapters/slack/index.js'

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

/**
 * Draws the App Home page for whoever just opened it.
 *
 * Every expected dead end (wrong tab, no bot for this workspace, no assistant on its
 * conversation) is a quiet early return rather than an error: the person simply sees the
 * empty tab Slack shows today. Only a genuine failure is logged.
 */
const publishAppHome = async (req, payload) => {
  const { event } = payload
  // Slack fires this for the Messages tab too, which opens far more often than the Home tab.
  if (event.tab !== 'home') return

  const target = req.slackAppHome ?? (await findSlackAppHomeTarget({ appKey: req.params?.appKey, payload }))
  if (!target) return
  const { adapter, sharedChannelId, channelAgentConfig, directAgentConfig } = target

  /* The bot's name and the list of things it can look up come from whichever assistant the
     reader will actually be talking to. Automatic updates have to come from the channel
     assistant instead, since a direct-message conversation never ends and so never posts one. */
  const settings = {
    ...(directAgentConfig ?? channelAgentConfig),
    notifications: channelAgentConfig?.notifications ?? []
  }

  const pageData = buildAppHomeData(settings, {
    channelId: sharedChannelId,
    canDirectMessage: Boolean(directAgentConfig)
  })

  // event.channel is this reader's own conversation with the bot, where clicked questions go.
  await publishHomeView(adapter.config.botToken, event.user, renderAppHomePage(pageData), event.channel)
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
  if (event.type === 'app_home_opened') {
    /* Slack needs a fast 200 and retries anything else, so a page that fails to draw is
       logged and swallowed rather than turned into a failed delivery. */
    try {
      await publishAppHome(req, payload)
    } catch (err) {
      logger.error(`Failed to publish Slack App Home for user ${event.user}: ${err.message}`)
    }
    res.status(httpStatus.OK).send('ok')
    return
  }

  // Skip bot messages to prevent loops and skip messages with subtypes, which are not user messages (they represent events like user joining a channel, etc)
  // The middleware already resolved and validated the adapter for this workspace/channel.
  if (event.type === 'message' && !event.bot_id && !event.subtype) {
    // TODO limit same Slack channel to one active Conversation
    await webhookService.receiveMessage(req.slackAdapter, event)
  }

  if (event.type === 'member_joined_channel') {
    await webhookService.participantJoined(req.slackAdapter, event)
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
    /* An app_home_opened payload is the one event type that names its workspace at the top
       level instead of on the event, so it needs its own lookup. Deliberately not widened to
       every event type: many others also lack event.team, and today they fall through to the
       global secret and get a harmless 200. Routing those through adapter lookup would turn
       the unresolvable ones into 401s, and Slack disables webhooks that keep failing. */
    const isAppHome = req.body?.event?.type === 'app_home_opened'
    // Slack's API still calls workspaces "teams", so `team` is the workspace ID.
    const slackWorkspaceId: string | undefined =
      req.body?.team_id ?? req.body?.event?.team ?? (isAppHome ? req.body?.team_id : undefined)
    const canIdentifyAdapter = Boolean(appKey || slackWorkspaceId)

    if (!canIdentifyAdapter) {
      const isValid = validateSignature(slackTimestamp, rawBody, slackSignature, config.slack.signingSecret)
      if (!isValid) {
        throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
      }
      next()
      return
    }

    const appHomeTarget = isAppHome ? await findSlackAppHomeTarget({ appKey, payload: req.body }) : null
    const slackAdapter = isAppHome ? appHomeTarget?.adapter : await findSlackAdapter({ appKey, payload: req.body })
    if (!slackAdapter) {
      /* An App Home notice arrives whenever anyone clicks the app in their sidebar, including
         while the assistant is stopped, and a stopped assistant leaves no row to check the
         signature against. Fall back to the shared secret and let the handler draw nothing:
         answering 401 to every click would eventually make Slack stop delivering events to
         this app altogether, taking ordinary messages down with the page. */
      if (isAppHome && validateSignature(slackTimestamp, rawBody, slackSignature, config.slack.signingSecret)) {
        next()
        return
      }
      // Stay deliberately vague: don't reveal whether the adapter is missing or the signature is bad.
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
    }

    const isValid = validateSignature(slackTimestamp, rawBody, slackSignature, resolveSlackSigningSecret(slackAdapter))
    if (!isValid) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid Slack signature')
    }

    req.slackAdapter = slackAdapter
    // Carried through so drawing the page doesn't repeat the lookup the signature check just did.
    req.slackAppHome = appHomeTarget
    next()
  } catch (err) {
    next(err)
  }
}
export default { handleEvent, middleware }
