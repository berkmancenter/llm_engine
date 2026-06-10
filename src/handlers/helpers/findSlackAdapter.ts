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
 * Find the Slack Adapter row a webhook belongs to.
 *
 * Lookup order:
 *   1. `config.appKey` if an appKey was provided (new per-bot URL shape:
 *      `/v1/webhooks/slack/:appKey`).
 *   2. `config.workspace` + `config.channel` derived from the event payload
 *      (the original Berkie URL shape, kept as a fallback so existing webhook
 *      URLs keep working through the rollout).
 *
 * DM events (`channel_type === 'im'`) match on the workspace's
 * `config.channel === 'direct'` adapter, mirroring the legacy handler.
 *
 * Returns null when nothing matches, so callers can decide how to respond
 * (typically with a 401 to avoid leaking which side is wrong).
 */
export default async function findSlackAdapter({
  appKey,
  payload
}: {
  appKey?: string
  payload: SlackPayload
}): Promise<AdapterDocument | null> {
  if (appKey) {
    const byAppKey = await Adapter.findOne({ type: 'slack', 'config.appKey': appKey })
    if (byAppKey) return byAppKey
  }

  const event = payload?.event
  if (!event?.team) return null

  if (event.channel_type === 'im') {
    return Adapter.findOne({ type: 'slack', 'config.channel': 'direct', 'config.workspace': event.team })
  }

  if (!event.channel) return null
  return Adapter.findOne({ type: 'slack', 'config.channel': event.channel, 'config.workspace': event.team })
}
