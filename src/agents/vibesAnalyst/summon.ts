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
  computeTrendViewsLive,
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

/* The reply when a trend was asked for but there is nothing to compare: no stored snapshots and
   no past events to recompute live either. This is the genuinely-empty case (a space with fewer
   than two past public events), not the "snapshots not seeded yet" case, which the live recompute
   now covers. */
export function noTrendDataMessage(): string {
  return "I don't have any past events to compare there yet. Once an event has wrapped up, I can read it and start building a trend."
}

/* The shared "here's how to ask" guidance, with a few recent public events to pick from.
   Both the greeting and the help reply use it, so someone who addresses VA without naming an
   event gets pointed at something concrete instead of a bare instruction. */
function usageGuideWithEvents(recent: EventCandidate[]): string {
  const howTo =
    'Mention me with a past public event and I\'ll read its engagement data and tell you what stood out. You can ask for "the latest", or compare recent events to see how things have moved (for example "how was engagement across the last 3 events?").'
  if (recent.length === 0) {
    return `${howTo}\nNo public events have wrapped up yet, so there's nothing to read so far.`
  }
  const list = recent.map((candidate) => `• ${candidate.name}`).join('\n')
  return `${howTo}\nRecent public events:\n${list}\nReply with one of these names, or ask for "the latest".`
}

/* The reply to a greeting or liveness check ("hi", "are you there?"): confirm VA is up, then
   guide the asker toward a recap so the greeting turns into something useful. In the analyst's
   voice (see VIBES_VOICE): present and paying attention to the numbers. */
export function greetingMessage(recent: EventCandidate[]): string {
  return `Here, and watching the numbers. ${usageGuideWithEvents(recent)}`
}

/* The reply to a help or capability question ("what can you do?", "how do I use you?"): the
   same usage guidance, framed as an answer to what VA is for. */
export function helpMessage(recent: EventCandidate[]): string {
  return `Here's what I do. ${usageGuideWithEvents(recent)}`
}

/* The reply when a message is addressed to VA but is not a recap, greeting, or help question.
   It redirects to what VA does without dumping the event list, since the asker was not looking
   for one. */
export function offTopicMessage(): string {
  return 'That\'s outside what I read. I analyze engagement from public events: mention me with an event name, or ask for "the latest" and I\'ll take the most recent.'
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
  llm,
  fastLlm = llm
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
  const { renderData } = await buildVibesSummary(conversation, llm, fastLlm)
  // Fallback text for adapters that do not render the card (e.g. zoom); the card itself
  // rides along as responseKind + renderData for adapters that do (Slack).
  return [
    reply(context, parent, `Vibes summary for *${conversation.name}*`, { responseKind: 'curatedVibesSummary', renderData })
  ]
}

/**
 * Answers a cross-event trend question. Scopes to the named series (or all public events when
 * none is named) and posts a comparative card. It prefers stored snapshots, and when too few
 * exist to compare (a fresh deploy, or events that ended before the snapshot write shipped) it
 * recomputes the scoped events live instead of dead-ending, so a trend still answers when the
 * data exists but was never snapshotted. Live rows are used for the WHOLE comparison rather than
 * mixed with stored ones, so every event is measured the same way. Either source is confined to
 * the privacy-filtered candidate set, so a private event can never enter a trend. With nothing to
 * compare it says so; with exactly one event it falls back to a normal single-event recap, since
 * one event is not a trend.
 */
async function handleTrendSummon(
  context,
  parent: AgentResponse<string>['parent'],
  reference: EventReference,
  candidates: EventCandidate[],
  recent: EventCandidate[],
  llm,
  fastLlm = llm
): Promise<AgentResponse<string>[]> {
  const scoped = resolveTrendScope(reference, candidates)
  const limit = trendEventCount(reference)
  const snapshots = await fetchTrendSnapshots(scoped, limit)
  const views = snapshots.length >= 2 ? snapshots : await computeTrendViewsLive(scoped, limit)

  // When the live recompute turns up a real multi-event trend but the stored snapshots did not,
  // the snapshot store has gone cold: usually a METRICS_VERSION bump orphaned every stored row, or
  // it was never seeded. Left silent, the trend keeps answering while quietly recomputing every
  // event on each request, so flag the remedy. A genuinely empty topic yields fewer than two live
  // views and does not warn.
  if (snapshots.length < 2 && views.length >= 2) {
    logger.warn(
      `Vibes Analyst recomputed a ${views.length}-event trend live because the snapshot store held ${snapshots.length}. Run the snapshot backfill so trends read from stored history.`
    )
  }

  if (views.length === 0) {
    return [reply(context, parent, noTrendDataMessage())]
  }
  if (views.length === 1) {
    return recapResolvedEvent(
      context,
      parent,
      views[0].conversationId.toString(),
      reference.eventQuery,
      recent,
      llm,
      fastLlm
    )
  }

  const renderData = await buildTrendSummary(views, llm)
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
export default async function handleSummon(context, userMessage, llm, fastLlm = llm): Promise<AgentResponse<string>[]> {
  const parent = userMessage._id

  // Parsing the message and loading the candidate events are independent, so run them at once.
  // The parse is a mechanical classification, so it runs on the faster model; the candidate
  // lookup is a DB read that takes no model at all.
  const [reference, candidates] = await Promise.all([
    extractEventReference(userMessage.body ?? '', fastLlm),
    findCandidatePublicEvents()
  ])

  // Newest first, capped, so a miss can suggest real recent events instead of dead-ending.
  const recent = [...candidates].sort((a, b) => b.endTime.getTime() - a.endTime.getTime()).slice(0, MAX_RECENT_SUGGESTIONS)

  // Addressed to VA but not asking for a recap: answer with a canned reply rather than
  // resolving an event. Greeting and help both guide toward a recap; off-topic redirects.
  if (reference.intent === 'greeting') return [reply(context, parent, greetingMessage(recent))]
  if (reference.intent === 'help') return [reply(context, parent, helpMessage(recent))]
  if (reference.intent === 'offTopic') return [reply(context, parent, offTopicMessage())]

  if (reference.trend) {
    return handleTrendSummon(context, parent, reference, candidates, recent, llm, fastLlm)
  }

  // A recap that names no event at all (a bare greeting the parser did not tag, or an empty
  // ask): guide the asker instead of dumping the not-found event list.
  if (!(reference.eventQuery ?? '').trim() && !reference.latestOverall && !reference.latestInTopic) {
    return [reply(context, parent, helpMessage(recent))]
  }

  const resolution = resolveSummonedEvent(reference, candidates)
  if (resolution.status === 'notFound') {
    return [reply(context, parent, notFoundMessage(reference.eventQuery, recent))]
  }
  if (resolution.status === 'ambiguous') {
    return [reply(context, parent, ambiguousMessage(resolution.candidates))]
  }

  return recapResolvedEvent(context, parent, resolution.event.id, reference.eventQuery, recent, llm, fastLlm)
}
