import Adapter, { AdapterDocument } from '../../models/adapter.model.js'
import logger from '../../config/logger.js'

type SlackEvent = {
  type?: string
  channel?: string
  channel_type?: string
  team?: string
}

type SlackPayload = {
  team_id?: string
  event?: SlackEvent
}

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
 * Direct-message events use a fixed channel name ("direct") on the row,
 * since a DM channel ID is per-user and not stored on the adapter.
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
    const channel = event?.channel_type === 'im' ? 'direct' : event?.channel
    if (!slackWorkspaceId || !channel) {
      logger.warn(`Slack appKey lookup for '${appKey}' received a payload with no workspace or channel — cannot route`)
      return null
    }
    // Match on appKey+workspace+channel so the same app can be wired to multiple channels,
    // each in its own conversation. Workspace validation also keeps a leaked URL from being
    // probed with forged payloads from other workspaces.
    return Adapter.findOne({
      type: 'slack',
      'config.appKey': appKey,
      'config.workspace': slackWorkspaceId,
      'config.channel': channel
    })
  }

  if (!slackWorkspaceId) return null

  // Only route to the active adapter. Failed/old conversations can leave inactive
  // adapter docs for the same channel+workspace; without this filter findOne may
  // return a stale inactive one (insertion order) and the message is silently dropped.
  if (event?.channel_type === 'im') {
    return Adapter.findOne({ type: 'slack', 'config.channel': 'direct', 'config.workspace': slackWorkspaceId, active: true })
  }

  if (!event?.channel) return null
  return Adapter.findOne({
    type: 'slack',
    'config.channel': event.channel,
    'config.workspace': slackWorkspaceId,
    active: true
  })
}
