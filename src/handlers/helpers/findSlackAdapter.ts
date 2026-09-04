import Adapter, { AdapterDocument } from '../../models/adapter.model.js'
import Agent from '../../models/user.model/agent.model/index.js'
import logger from '../../config/logger.js'

type SlackEvent = {
  type?: string
  channel?: string
  channel_type?: string
  team?: string
}

type SlackPayload = {
  type?: string
  event?: SlackEvent
  team_id?: string
  authorizations?: { is_bot?: boolean; user_id?: string }[]
}

const COMMUNITY_ASSISTANT_AGENT_TYPE = 'communityAssistant'
/* The literal channel name marking the one Conversation that handles every direct message
   in a workspace. See docs/pages/platforms/slack.md, "Direct messages". */
const DIRECT_CHANNEL = 'direct'

/**
 * Find the database row for the Slack bot that should receive a webhook.
 *
 * Tries two lookup paths:
 *
 * 1. **appKey path** (`/v1/webhooks/slack/:appKey`): matches on appKey + workspace + channel.
 *    The channel discriminator means the same Slack app can be wired to multiple channels
 *    simultaneously, each mapped to its own conversation — configure one Adapter row per
 *    channel with the same appKey. The workspace check prevents a leaked URL from being
 *    probed with forged payloads from a different workspace.
 *    Use this path when multiple different Slack apps post to the same channel (each app
 *    gets its own appKey, its own signing secret, and its own Adapter row).
 *
 * 2. **Catch-all path** (`/v1/webhooks/slack`): matches on workspace + channel from the
 *    payload. Sufficient when each channel has at most one app. Cannot distinguish two
 *    different apps in the same channel.
 *
 * Workspace is read from the outer `team_id` field first (present on all event callback
 * payloads, including message subtypes that omit `team` from the event object), falling
 * back to `event.team` for older payload shapes.
 *
 * Direct-message events are routed by finding the adapter for the workspace that has
 * `dmChannels` configured, since DM channel IDs are per-user and cannot be stored on
 * the adapter row. At most one adapter per workspace (or per appKey+workspace) may have
 * dmChannels, enforced at save time by the Slack adapter's validateBeforeUpdate.
 *
 * Returns null if nothing matches. Callers should respond 401 rather than
 * 404 so the response doesn't reveal which Slack channels are wired up.
 */
export default async function findSlackAdapter({
  appKey,
  payload
}: {
  appKey?: string
  payload: SlackPayload
}): Promise<AdapterDocument | null> {
  const event = payload?.event
  // team_id on the outer payload is more reliable than event.team — it is present on all
  // event callback payloads including message subtypes that omit team from the event object.
  const slackWorkspaceId = payload?.team_id ?? event?.team
  if (appKey) {
    if (!slackWorkspaceId) {
      // url_verification has no event or workspace — Slack sends it to confirm the endpoint
      // during app setup. Fall back to appKey-only so the middleware can resolve the signing
      // secret and respond to the challenge.
      if (payload.type === 'url_verification') {
        return Adapter.findOne({ type: 'slack', 'config.appKey': appKey, active: true })
      }
      logger.warn(`Slack appKey lookup for '${appKey}' received a payload with no workspace — cannot route`)
      return null
    }
    if (event?.channel_type === 'im') {
      return Adapter.findOne({
        type: 'slack',
        'config.appKey': appKey,
        'config.workspace': slackWorkspaceId,
        dmChannels: { $exists: true, $not: { $size: 0 } },
        active: true
      })
    }
    const channel = event?.channel
    if (!channel) {
      logger.warn(`Slack appKey lookup for '${appKey}' received a payload with no channel — cannot route`)
      return null
    }
    // Match on appKey+workspace+channel so the same app can be wired to multiple channels,
    // each in its own conversation. Workspace validation also keeps a leaked URL from being
    // probed with forged payloads from other workspaces.
    return Adapter.findOne({
      type: 'slack',
      'config.appKey': appKey,
      'config.workspace': slackWorkspaceId,
      'config.channel': channel,
      active: true
    })
  }

  if (!slackWorkspaceId) return null

  // Only route to the active adapter. Failed/old conversations can leave inactive
  // adapter docs for the same channel+workspace; without this filter findOne may
  // return a stale inactive one (insertion order) and the message is silently dropped.
  if (event?.channel_type === 'im') {
    // DMs have no stable channel ID to match on, so find the adapter for this workspace that
    // has dmChannels configured. appKey narrows to the right app when multiple apps share
    // a workspace; at most one adapter per appKey+workspace should have dmChannels (enforced
    // at save time in the Slack adapter's validateBeforeUpdate).
    const dmQuery: Record<string, unknown> = {
      type: 'slack',
      'config.workspace': slackWorkspaceId,
      dmChannels: { $exists: true, $not: { $size: 0 } },
      active: true
    }
    if (appKey) dmQuery['config.appKey'] = appKey
    return Adapter.findOne(dmQuery)
  }

  if (!event?.channel) return null
  return Adapter.findOne({
    type: 'slack',
    'config.channel': event.channel,
    'config.workspace': slackWorkspaceId,
    active: true
  })
}

export interface SlackAppHomeTarget {
  /* The row supplying the bot token the page is published with, and the signing secret its
     notice was checked against. Every eligible row belongs to the same Slack app, so the
     choice between them only decides which stored secret and token get used. */
  adapter: AdapterDocument
  /* The shared channel where the assistant runs, when the workspace has one. The page points
     readers at it, and the direct-message row carries no record that the channel exists. */
  sharedChannelId?: string
  /* Settings of the assistant answering in that shared channel. The page's automatic-updates
     list has to come from here: those notices are posted by the conversation that ends, and a
     direct-message conversation never ends. */
  channelAgentConfig?: Record<string, unknown>
  /* Settings of the assistant answering direct messages, when the workspace runs one. Its
     presence is also what makes starter questions clickable, since a click is answered there
     and nowhere else. */
  directAgentConfig?: Record<string, unknown>
}

/**
 * Find the Slack bot whose App Home a user just opened, and the channel its page should
 * point readers at.
 *
 * Kept separate from {@link findSlackAdapter} because an `app_home_opened` payload
 * identifies itself differently: the workspace sits at the top level as `team_id`
 * rather than on the event, and the bot's own user id arrives under `authorizations`.
 * The Home tab also belongs to the whole Slack app rather than to one channel, so a
 * workspace running the bot in a channel and in direct messages produces two candidate
 * rows and the caller needs the one that can describe the assistant.
 *
 * A workspace can run the assistant in a channel and in direct messages at once, and the
 * page needs both: the channel conversation says which channel to point at and which notices
 * get posted, and the direct one says whether a clicked question has anywhere to land. So
 * both come back, rather than one row the caller has to guess the rest from.
 *
 * Returns null when the workspace runs no community assistant, which the caller treats
 * as "publish nothing" rather than as an error.
 */
export async function findSlackAppHomeTarget({
  appKey,
  payload
}: {
  appKey?: string
  payload: SlackPayload
}): Promise<SlackAppHomeTarget | null> {
  const workspaceId = payload?.team_id
  if (!workspaceId) return null

  const botUserId = payload?.authorizations?.find((authorization) => authorization.is_bot)?.user_id
  /* Every row for this workspace is fetched even when the address named one, since the page
     needs both the assistant's own row and the shared channel it should point at, and those
     are two different rows. A row in another workspace is never a candidate, which is the
     same anti-probe check findSlackAdapter makes on a leaked webhook address. */
  const candidates = await Adapter.find({
    type: 'slack',
    'config.workspace': workspaceId,
    active: true,
    // Slack can truncate authorizations, so fall back to every bot in the workspace.
    ...(botUserId && { 'config.botUserId': botUserId })
  })
  if (candidates.length === 0) return null

  const withAssistant = await Agent.find({
    conversation: { $in: candidates.map((candidate) => candidate.conversation) },
    agentType: COMMUNITY_ASSISTANT_AGENT_TYPE
  }).select('conversation agentConfig')
  const settingsByConversation = new Map(
    withAssistant.map((agent) => [agent.conversation.toString(), agent.agentConfig as Record<string, unknown>])
  )

  const eligible = candidates.filter((candidate) => settingsByConversation.has(candidate.conversation.toString()))
  if (eligible.length === 0) {
    logger.debug(`App Home: workspace ${workspaceId} runs no community assistant, nothing to publish`)
    return null
  }

  const namedByAddress = appKey ? eligible.find((candidate) => candidate.config?.appKey === appKey) : undefined
  const directMessages = eligible.find((candidate) => candidate.config?.channel === DIRECT_CHANNEL)
  const sharedChannel = eligible.find((candidate) => candidate.config?.channel !== DIRECT_CHANNEL)
  const settingsOf = (candidate?: AdapterDocument) =>
    candidate && settingsByConversation.get(candidate.conversation.toString())

  return {
    adapter: namedByAddress ?? directMessages ?? eligible[0],
    sharedChannelId: sharedChannel?.config?.channel as string | undefined,
    channelAgentConfig: settingsOf(sharedChannel),
    directAgentConfig: settingsOf(directMessages)
  }
}
