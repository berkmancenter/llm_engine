import Adapter, { AdapterDocument } from '../../models/adapter.model.js'
import Agent from '../../models/user.model/agent.model/index.js'
import ConversationMembership from '../../models/conversationMembership.model.js'
import logger from '../../config/logger.js'

type SlackEvent = {
  type?: string
  channel?: string
  channel_type?: string
  team?: string
  user?: string
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
 * Given several candidate conversation ids, finds the one (if any) this Slack user is an
 * active member of — the shared "which community does this person belong to" primitive
 * behind both DM routing (resolveSlackDmAdapter) and App Home resolution
 * (findSlackAppHomeTarget), for a workspace running more than one community assistant on
 * the same Slack app. Picks the first match when a person belongs to more than one;
 * deliberately not handled more carefully for now — revisit only if that turns out common.
 */
async function matchMemberConversation(conversationIds: string[], slackUserId: string): Promise<string | undefined> {
  const memberships = await ConversationMembership.find({
    conversation: { $in: conversationIds },
    'externalIds.slack': slackUserId,
    status: 'active'
  }).select('conversation')
  return memberships[0]?.conversation.toString()
}

export interface SlackDmResolution {
  /* The adapter that should actually receive this DM, or null when nothing in this
     workspace/appKey runs DMs at all. When `unresolved` is true this is populated with an
     arbitrary DM-capable candidate instead — not a conversation to deliver into, but a real
     row whose bot token/signing secret the caller can still validate the webhook against, so a
     legitimate "I don't recognize this sender" case can be acknowledged with 200 rather than
     rejected (and endlessly retried by Slack) as if it were a bad signature. */
  adapter: AdapterDocument | null
  /* True when this workspace/app runs more than one DM-capable community and the sender
     couldn't be matched to any of them by Slack channel membership. The caller must still
     acknowledge the webhook, but must not actually deliver the message anywhere. */
  unresolved?: boolean
}

/**
 * Finds the Slack adapter that should handle a direct message from `slackUserId` in this
 * workspace. A workspace that truly runs only one community (the common case, and every case
 * before multiple communities could share one Slack app) is resolved with no membership lookup
 * at all — zero behavior or cost change there.
 *
 * The lone-candidate case still has to check for *other* communities sharing this bucket before
 * trusting that shortcut, though: a single DM-capable adapter doesn't mean a single community —
 * a second community that never turned DMs on is invisible to the `dmChannels` filter, and its
 * members must not be silently routed to the one adapter that does have DMs just because it's
 * the only candidate the query found. Only once there's more than one DM-capable adapter (or a
 * channel-only community lurking alongside the lone one) does it fall back to
 * {@link matchMemberConversation}, and even then only to disambiguate.
 *
 * `unresolved: true` means "this is a legitimate DM from somewhere in the workspace, just not
 * from anyone we can place" — not "this request looks forged." Callers must still acknowledge
 * the webhook (Slack retries indefinitely otherwise) but must not route the message anywhere.
 */
export async function resolveSlackDmAdapter({
  workspaceId,
  slackUserId,
  appKey
}: {
  workspaceId: string
  slackUserId?: string
  appKey?: string
}): Promise<SlackDmResolution> {
  const baseQuery: Record<string, unknown> = {
    type: 'slack',
    'config.workspace': workspaceId,
    active: true
  }
  if (appKey) baseQuery['config.appKey'] = appKey

  const candidates = await Adapter.find({
    ...baseQuery,
    dmChannels: { $exists: true, $not: { $size: 0 } }
  })
  if (candidates.length === 0) return { adapter: null }

  if (candidates.length === 1) {
    // Cheap, indexed, and only runs for the lone-candidate case — the common zero-candidate and
    // already-ambiguous (>1) cases never pay for it.
    const otherChannelConversations = await Adapter.distinct('conversation', {
      ...baseQuery,
      conversation: { $ne: candidates[0].conversation },
      'config.channel': { $ne: DIRECT_CHANNEL }
    })
    if (otherChannelConversations.length === 0) return { adapter: candidates[0] }
  }
  if (!slackUserId) return { adapter: candidates[0], unresolved: true }

  const matchedConversationId = await matchMemberConversation(
    candidates.map((candidate) => candidate.conversation.toString()),
    slackUserId
  )
  const matched =
    matchedConversationId && candidates.find((candidate) => candidate.conversation.toString() === matchedConversationId)
  return matched ? { adapter: matched } : { adapter: candidates[0], unresolved: true }
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
 * Direct-message events are routed via {@link resolveSlackDmAdapter} — DM channel IDs are
 * per-user and cannot be stored on the adapter row, so it finds every adapter in this
 * workspace (or appKey+workspace) with `dmChannels` configured and, when more than one
 * community shares that bucket, disambiguates by which one the sender is a member of.
 *
 * Returns `{ adapter: null }` if nothing matches. Callers should respond 401 rather than 404
 * so the response doesn't reveal which Slack channels are wired up. A DM whose sender can't be
 * placed in any community instead comes back `unresolved: true` — see
 * {@link resolveSlackDmAdapter} — so callers can still validate and acknowledge the webhook
 * rather than rejecting it and triggering Slack's retry behavior.
 */
export default async function findSlackAdapter({
  appKey,
  payload
}: {
  appKey?: string
  payload: SlackPayload
}): Promise<SlackDmResolution> {
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
        return { adapter: await Adapter.findOne({ type: 'slack', 'config.appKey': appKey, active: true }) }
      }
      logger.warn(`Slack appKey lookup for '${appKey}' received a payload with no workspace — cannot route`)
      return { adapter: null }
    }
    if (event?.channel_type === 'im') {
      return resolveSlackDmAdapter({ workspaceId: slackWorkspaceId, slackUserId: event.user, appKey })
    }
    const channel = event?.channel
    if (!channel) {
      logger.warn(`Slack appKey lookup for '${appKey}' received a payload with no channel — cannot route`)
      return { adapter: null }
    }
    // Match on appKey+workspace+channel so the same app can be wired to multiple channels,
    // each in its own conversation. Workspace validation also keeps a leaked URL from being
    // probed with forged payloads from other workspaces.
    return {
      adapter: await Adapter.findOne({
        type: 'slack',
        'config.appKey': appKey,
        'config.workspace': slackWorkspaceId,
        'config.channel': channel,
        active: true
      })
    }
  }

  if (!slackWorkspaceId) return { adapter: null }

  // Only route to the active adapter. Failed/old conversations can leave inactive
  // adapter docs for the same channel+workspace; without this filter findOne may
  // return a stale inactive one (insertion order) and the message is silently dropped.
  if (event?.channel_type === 'im') {
    // DMs have no stable channel ID to match on, so find the adapter for this workspace that
    // has dmChannels configured. appKey narrows to the right app when multiple apps share a
    // workspace; resolveSlackDmAdapter disambiguates further by Slack channel membership when
    // more than one community in this (workspace, appKey) bucket has dmChannels.
    return resolveSlackDmAdapter({ workspaceId: slackWorkspaceId, slackUserId: event?.user, appKey })
  }

  if (!event?.channel) return { adapter: null }
  return {
    adapter: await Adapter.findOne({
      type: 'slack',
      'config.channel': event.channel,
      'config.workspace': slackWorkspaceId,
      active: true
    })
  }
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
  /* True when this workspace/app runs more than one community and the viewer couldn't be
     matched to any of them by Slack channel membership. `adapter` is still populated (any
     eligible row works, since they share one bot token) purely so the caller can publish a
     page — but sharedChannelId/channelAgentConfig/directAgentConfig are meaningless here and
     the caller should render a "join a channel" prompt instead of the normal page. */
  unresolved?: boolean
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
 * as "publish nothing" rather than as an error. When a workspace/app runs more than one
 * community, narrows to the one the viewer is a Slack-channel member of first (see
 * matchMemberConversation) — or returns `unresolved: true` when that can't be determined,
 * so the caller can show a "join a channel" prompt instead of guessing.
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

  let eligible = candidates.filter((candidate) => settingsByConversation.has(candidate.conversation.toString()))
  if (eligible.length === 0) {
    logger.debug(`App Home: workspace ${workspaceId} runs no community assistant, nothing to publish`)
    return null
  }

  // appKey, when the webhook address carries one, identifies a specific Slack app — narrow to
  // just its own rows before anything else below. This matters for a workspace running
  // several different apps (botUserId normally already narrows to one, this recovers
  // precision when authorizations was truncated); it's a no-op for multiple communities on
  // one shared app, since they all carry the same appKey.
  if (appKey) {
    const appKeyEligible = eligible.filter((candidate) => candidate.config?.appKey === appKey)
    if (appKeyEligible.length > 0) eligible = appKeyEligible
  }

  // Disambiguate separately per role (channel vs. direct) rather than across the whole
  // candidate set. A single community legitimately splits its channel and its own
  // always-on direct conversation across two Conversation records (see
  // slack.handler.test.ts's addDirectConversation) — that's exactly one distinct
  // conversation per role, so it's never ambiguous and never touches membership.
  //
  // Whether a role's own candidate count is safe to trust, though, depends on the OTHER role
  // too — not just itself. If A has DMs on and B doesn't, the direct role only ever sees A (one
  // candidate), but the channel role sees both A and B: the workspace plainly runs more than one
  // community, so a B member must not be resolved into A's direct-message settings just because
  // the direct role, in isolation, looked unambiguous. So both roles only skip membership when
  // *neither* role, on its own, found more than one distinct conversation — the split-single-
  // community case above is still free (1 and 1), but "1 direct / 2 channel" (or the reverse) now
  // requires membership for both roles, even the one that looked unambiguous by itself.
  const directCandidates = eligible.filter(
    (candidate) => candidate.config?.channel === DIRECT_CHANNEL || (candidate.dmChannels?.length ?? 0) > 0
  )
  const channelCandidates = eligible.filter((candidate) => candidate.config?.channel !== DIRECT_CHANNEL)
  const directIds = [...new Set(directCandidates.map((candidate) => candidate.conversation.toString()))]
  const channelIds = [...new Set(channelCandidates.map((candidate) => candidate.conversation.toString()))]
  const singleCommunityWorkspace = directIds.length <= 1 && channelIds.length <= 1

  const slackUserId = payload?.event?.user
  const resolveRole = async (roleCandidates: AdapterDocument[], ids: string[]): Promise<AdapterDocument[]> => {
    if (singleCommunityWorkspace) return roleCandidates
    const matchedConversationId = slackUserId ? await matchMemberConversation(ids, slackUserId) : undefined
    if (!matchedConversationId) return []
    return roleCandidates.filter((candidate) => candidate.conversation.toString() === matchedConversationId)
  }

  const directRoleCandidates = await resolveRole(directCandidates, directIds)
  const channelRoleCandidates = await resolveRole(channelCandidates, channelIds)

  if (directRoleCandidates.length === 0 && channelRoleCandidates.length === 0) {
    // Both roles had more than one competing community and the viewer couldn't be matched to
    // any of them — nothing left to describe accurately.
    logger.debug(`App Home: workspace ${workspaceId} runs multiple communities, viewer unmatched`)
    return { adapter: eligible[0], unresolved: true }
  }

  const namedByAddress = appKey ? eligible.find((candidate) => candidate.config?.appKey === appKey) : undefined
  const directMessages = directRoleCandidates[0]
  // Prefer a channel explicitly marked for display; fall back to any other eligible one.
  const sharedChannel =
    channelRoleCandidates.find((candidate) => candidate.config?.showOnAppHome) ?? channelRoleCandidates[0]
  const settingsOf = (candidate?: AdapterDocument) =>
    candidate && settingsByConversation.get(candidate.conversation.toString())

  return {
    adapter: namedByAddress ?? directMessages ?? sharedChannel ?? eligible[0],
    sharedChannelId: sharedChannel?.config?.channel as string | undefined,
    channelAgentConfig: settingsOf(sharedChannel),
    directAgentConfig: settingsOf(directMessages)
  }
}
