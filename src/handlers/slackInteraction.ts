/**
 * Handles interactive component payloads from Slack (e.g. button clicks).
 * Routes block_actions payloads back into the normal message pipeline so agents
 * can respond to user interactions the same way they respond to messages.
 */

import httpStatus from 'http-status'
import Adapter from '../models/adapter.model.js'
import webhookService from '../services/webhook.service.js'
import logger from '../config/logger.js'
import ApiError from '../utils/ApiError.js'

/**
 * Fields present on Slack block_actions action elements. Different interactive
 * element types expose their selected value in different fields — see extractActionValue.
 */
interface SlackBlockAction {
  action_id: string
  // button
  value?: string
  // static_select, external_select, overflow, radio_buttons, users/conversations/channels_select
  selected_option?: { value: string }
  // multi_static_select, multi_external_select, checkboxes, multi_users/conversations/channels_select
  selected_options?: { value: string }[]
  // datepicker
  selected_date?: string
  // timepicker
  selected_time?: string
}

/**
 * Extracts a meaningful string value from a block_actions action element.
 * Returns undefined if the element carries no user-selected value (e.g. a
 * button with no value set), in which case the interaction should be skipped
 * rather than forwarding a developer identifier as message text.
 */
function extractActionValue(action: SlackBlockAction): string | undefined {
  return (
    action.value ??
    action.selected_option?.value ??
    action.selected_options?.map((o) => o.value).join(',') ??
    action.selected_date ??
    action.selected_time
  )
}

/** Minimum shape of a Slack block_actions payload */
interface SlackBlockActionsPayload {
  type: 'block_actions'
  team: { id: string }
  channel: { id: string } | null
  user: { id: string }
  actions: SlackBlockAction[]
  message?: { ts: string; thread_ts?: string }
  container?: { channel_id?: string }
  view?: { private_metadata?: string }
  response_url?: string
}

// Slack DM channel IDs begin with 'D'
const DM_CHANNEL_PREFIX = 'D'

/**
 * Works out which Slack conversation an interaction should be answered in.
 *
 * A click inside the App Home page carries no channel, because the page is not in one.
 * The page writes the reader's own conversation with the bot into `private_metadata` on
 * the way out, and only a private conversation is accepted back, so a click can never be
 * answered in front of a whole channel.
 */
function resolveChannelId(payload: SlackBlockActionsPayload): string | undefined {
  const fromClick = payload.channel?.id ?? payload.container?.channel_id
  if (fromClick) return fromClick

  const fromView = payload.view?.private_metadata
  if (!fromView) return undefined

  if (!fromView.startsWith(DM_CHANNEL_PREFIX)) {
    logger.warn(`Slack block_actions: view named ${fromView}, which is not a private conversation, ignoring`)
    return undefined
  }
  return fromView
}

/**
 * Receives a parsed Slack block_actions payload (sent when a user clicks a button),
 * looks up the matching adapter, and feeds the interaction into the message pipeline
 * as a synthetic message event.
 *
 * @param rawPayload - Parsed block_actions payload from Slack (typed as unknown since it comes from JSON.parse)
 */
async function receiveInteraction(rawPayload: unknown): Promise<void> {
  const payload = rawPayload as SlackBlockActionsPayload
  const resolvedChannelId = resolveChannelId(payload)
  if (!resolvedChannelId) {
    logger.warn(`Slack block_actions: no channel resolved for user ${payload.user.id}, ignoring`)
    return
  }

  const action = payload.actions[0]
  if (!action) {
    logger.warn(`Slack block_actions: payload had no actions from user ${payload.user.id}`)
    return
  }

  const text = extractActionValue(action)
  if (!text) {
    logger.warn(`Slack block_actions: no extractable value from action ${action.action_id}, ignoring`)
    return
  }

  const isIM = resolvedChannelId.startsWith(DM_CHANNEL_PREFIX)

  const slackAdapter = await Adapter.findOne(
    isIM
      ? {
          type: 'slack',
          dmChannels: { $exists: true, $not: { $size: 0 } },
          'config.workspace': payload.team.id,
          active: true
        }
      : { type: 'slack', 'config.channel': resolvedChannelId, 'config.workspace': payload.team.id, active: true }
  )

  if (!slackAdapter) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      `Slack adapter not found for workspace ${payload.team.id} channel ${resolvedChannelId}`
    )
  }

  const syntheticEvent = {
    type: 'message',
    text,
    ts: String(Date.now() / 1000), // Slack doesn't give interactions a timestamp, so this is approximate
    team: payload.team.id,
    user: payload.user.id,
    channel: resolvedChannelId,
    ...(isIM && { channel_type: 'im' }),
    /* Prefer message.thread_ts (Slack's own root-thread pointer) over
       message.ts so button clicks on bot replies are always parented to
       the thread root, not the intermediate message that held the buttons. */
    ...(payload.message && { thread_ts: payload.message.thread_ts ?? payload.message.ts }),
    response_url: payload.response_url
  }

  await webhookService.receiveMessage(slackAdapter, syntheticEvent)
}

export default { receiveInteraction }
