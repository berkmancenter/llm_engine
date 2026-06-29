import Conversation from '../../models/conversation.model.js'
import access from '../../auth/access.js'
import logger from '../../config/logger.js'
import { AgentResponse } from '../../types/index.types.js'
import buildVibesSummary from './buildSummary.js'
import buildTrendSummary from './trendSummary.js'
import {
  extractEventReference,
  findCandidatePublicEvents,
  resolveSummonedEvent,
  resolveTrendScope,
  trendEventCount,
  fetchTrendSnapshots,
  EventCandidate,
  EventReference
} from './eventResolution.js'

/* The channel the vibes analyst lives in and answers summons from. */
const SUMMON_CHANNEL = 'vibesAnalyst'

/* How many recent public events to offer back when nothing matched, so the reply gives
   the asker something to pick from instead of a dead end. */
const MAX_RECENT_SUGGESTIONS = 5

/* The reply when nothing public matches what was asked for. When there are recent public
   events to suggest, it lists them so the asker can pick one or ask for the latest, rather
   than guessing at an exact title. */
export function notFoundMessage(query: string, recent: EventCandidate[]): string {
  if (recent.length === 0) {
    return `I couldn't find a public event matching "${query}", and I don't have any public events to recap yet.`
  }
  const list = recent.map((candidate) => `• ${candidate.name}`).join('\n')
  return `I couldn't find a public event matching "${query}", and I recap one event at a time. Recent public events:\n${list}\nReply with one of these names, or ask for "the latest" and I'll take the most recent.`
}

/* The reply when several public events match and the asker needs to pick one. */
export function ambiguousMessage(candidates: EventCandidate[]): string {
  const list = candidates.map((candidate) => `• ${candidate.name}`).join('\n')
  return `A few public events match that. Which one did you mean?\n${list}`
}

/* The reply when a trend was asked for but no stored snapshots exist to compare. */
export function noTrendDataMessage(): string {
  return "I don't have stored metrics for those events yet, so I can't compare them. Once they've each been recapped (or the backfill has run), I can."
}

/* Builds a reply that threads under the summoning message, in the channel it came from.
   Threading keeps each recap attached to the question that asked for it. An optional
   card turns the plain reply into the rendered engagement summary. */
function reply(
  context,
  parent: AgentResponse<string>['parent'],
  message: string,
  card?: { responseKind: string; renderData: unknown }
): AgentResponse<string> {
  const channels = context.conversation.channels.filter((channel) => channel.name === SUMMON_CHANNEL)
  return { visible: true, message, messageType: 'text', channels, parent, ...card }
}

/**
 * Recaps one resolved public event on demand. Loads the event, re-checks read access (fail
 * closed: anything but an explicit public topic is refused, not recapped), and posts its
 * engagement card threaded under the summon. Shared by the single-event path and the trend
 * path's one-event fallback. Returns a not-found reply if the event has since disappeared.
 */
async function recapResolvedEvent(
  context,
  parent: AgentResponse<string>['parent'],
  conversationId: string,
  fallbackQuery: string,
  recent: EventCandidate[],
  llm
): Promise<AgentResponse<string>[]> {
  const conversation = await Conversation.findById(conversationId).populate('topic')
  if (!conversation) {
    return [reply(context, parent, notFoundMessage(fallbackQuery, recent))]
  }

  const topic = conversation.topic as { _id?: { toString(): string }; private?: boolean } | undefined
  try {
    access.assertCanRead(context, {
      type: 'conversation',
      id: conversation._id.toString(),
      topicId: topic?._id?.toString(),
      topicIsPrivate: topic?.private !== false
    })
  } catch (error: unknown) {
    logger.warn(
      `Vibes Analyst refused summon for ${conversation._id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return [reply(context, parent, `I can only recap public events, and "${conversation.name}" isn't one I can share.`)]
  }

  // A summon recaps a past event on demand. Only the auto path persists a metrics snapshot
  // (an event is snapshotted once, when it ends), so the metrics are unused here.
  const { renderData } = await buildVibesSummary(conversation, llm)
  // Fallback text for adapters that do not render the card (e.g. zoom); the card itself
  // rides along as responseKind + renderData for adapters that do (Slack).
  return [
    reply(context, parent, `Vibes summary for *${conversation.name}*`, { responseKind: 'curatedVibesSummary', renderData })
  ]
}

/**
 * Answers a cross-event trend question from stored snapshots rather than a live recap. Scopes
 * to the named series (or all public events when none is named), reads the most recent N
 * snapshots at the current metrics version, and posts a comparative card. The snapshot read is
 * confined to the privacy-filtered candidate set, so a private event can never enter a trend.
 * With no snapshots it says so; with exactly one it falls back to a normal single-event recap,
 * since one event is not a trend.
 */
async function handleTrendSummon(
  context,
  parent: AgentResponse<string>['parent'],
  reference: EventReference,
  candidates: EventCandidate[],
  recent: EventCandidate[],
  llm
): Promise<AgentResponse<string>[]> {
  const scoped = resolveTrendScope(reference, candidates)
  const snapshots = await fetchTrendSnapshots(scoped, trendEventCount(reference))

  if (snapshots.length === 0) {
    return [reply(context, parent, noTrendDataMessage())]
  }
  if (snapshots.length === 1) {
    return recapResolvedEvent(context, parent, snapshots[0].conversationId.toString(), reference.eventQuery, recent, llm)
  }

  const renderData = await buildTrendSummary(snapshots, llm)
  return [
    reply(context, parent, 'Engagement trend across recent events', { responseKind: 'curatedVibesSummary', renderData })
  ]
}

/**
 * Handles one on-demand summon. First works out whether the message asks about one event or a
 * cross-event trend, then routes accordingly: a trend is answered from stored snapshots, a
 * single event is resolved by name and recapped live. The candidate set is privacy-filtered and
 * access is re-checked before any content is read, so a summon can never surface a private
 * event. Every reply threads under the summoning message in the channel it came from.
 */
export default async function handleSummon(context, userMessage, llm): Promise<AgentResponse<string>[]> {
  const parent = userMessage._id

  const reference = await extractEventReference(userMessage.body ?? '', llm)
  const candidates = await findCandidatePublicEvents()

  // Newest first, capped, so a miss can suggest real recent events instead of dead-ending.
  const recent = [...candidates].sort((a, b) => b.endTime.getTime() - a.endTime.getTime()).slice(0, MAX_RECENT_SUGGESTIONS)

  if (reference.trend) {
    return handleTrendSummon(context, parent, reference, candidates, recent, llm)
  }

  const resolution = resolveSummonedEvent(reference, candidates)
  if (resolution.status === 'notFound') {
    return [reply(context, parent, notFoundMessage(reference.eventQuery, recent))]
  }
  if (resolution.status === 'ambiguous') {
    return [reply(context, parent, ambiguousMessage(resolution.candidates))]
  }

  return recapResolvedEvent(context, parent, resolution.event.id, reference.eventQuery, recent, llm)
}
