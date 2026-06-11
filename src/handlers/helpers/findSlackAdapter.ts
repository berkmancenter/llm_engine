import Adapter, { AdapterDocument } from '../../models/adapter.model.js'

type SlackEvent = {
  type?: string
  channel?: string
  channel_type?: string
  team?: string
}

type SlackPayload = {
  event?: SlackEvent
}

/**
 * Find the database row for the Slack bot that should receive a webhook.
 *
 * Tries two lookup paths:
 *   1. By the bot identifier carried in the webhook URL (when present).
 *   2. By the workspace and channel found inside the event payload.
 *
 * Direct-message events use a fixed channel name ("direct") on the row,
 * since a DM isn't tied to a specific channel ID.
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
  const eventTeam = payload?.event?.team
  if (appKey) {
    const byAppKey = await Adapter.findOne({ type: 'slack', 'config.appKey': appKey })
    if (byAppKey) {
      // A bot lives in one workspace. If the payload claims a different one, refuse the lookup
      // even though the URL matched a row. Keeps a leaked URL from being probed with forged
      // payloads from other workspaces.
      if (eventTeam && byAppKey.config?.workspace !== eventTeam) return null
      return byAppKey
    }
  }

  const event = payload?.event
  if (!event?.team) return null

  if (event.channel_type === 'im') {
    return Adapter.findOne({ type: 'slack', 'config.channel': 'direct', 'config.workspace': event.team })
  }

  if (!event.channel) return null
  return Adapter.findOne({ type: 'slack', 'config.channel': event.channel, 'config.workspace': event.team })
}
