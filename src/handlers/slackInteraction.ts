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
  response_url?: string
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
  // Resolve the channel ID — payload.channel can be null in modal/Home Tab contexts
  const resolvedChannelId = payload.channel?.id ?? payload.container?.channel_id
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

  // Slack DM channel IDs begin with 'D'
  const isIM = resolvedChannelId.startsWith('D')

  const slackAdapter = await Adapter.findOne(
    isIM
      ? { type: 'slack', 'config.channel': 'direct', 'config.workspace': payload.team.id }
      : { type: 'slack', 'config.channel': resolvedChannelId, 'config.workspace': payload.team.id }
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
