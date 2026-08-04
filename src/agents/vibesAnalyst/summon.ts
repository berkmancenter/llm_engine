import { z } from 'zod'
import Conversation from '../../models/conversation.model.js'
import access from '../../auth/access.js'
import logger from '../../config/logger.js'
import { AgentResponse } from '../../types/index.types.js'
import { buildSnapshotPayload } from '../../services/conversationMetricsSnapshot.service.js'
import conversationAnalyticsService from '../../services/conversationAnalytics.service.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import buildVibesSummary, { hasHistorianAgent } from './buildSummary.js'
import buildTrendSummary from './trendSummary.js'
import { resolveFollowUpContext, answerFollowUp, resolveDisambiguationContext } from './followUp.js'
import { VIBES_SMALLTALK_SYSTEM_PROMPT, VIBES_SMALLTALK_USER_TEMPLATE } from './prompt.js'
import {
  extractEventReference,
  findCandidatePublicEvents,
  resolveSummonedEvent,
  resolveTrendScope,
  resolveNamedTrendScope,
  trendEventCount,
  fetchTrendSnapshots,
  computeTrendViewsLive,
  MAX_TREND_EVENTS,
  EventCandidate,
  EventReference
} from './eventResolution.js'

/* The channel the vibes analyst lives in and answers summons from. */
const SUMMON_CHANNEL = 'vibesAnalyst'

/* How many recent public events to offer back when nothing matched, so the reply gives
   the asker something to pick from instead of a dead end. */
const MAX_RECENT_SUGGESTIONS = 5

/* Reads a snapshot-shaped row whether it is a Mongoose document (a stored snapshot, read via
   toObject) or a plain object (a live recompute), so metricsContext always persists as plain
   JSON rather than a Mongoose document's internal shape. */
function plainMetricsRow(row: unknown): unknown {
  const source = row as { toObject?: () => unknown }
  return typeof source.toObject === 'function' ? source.toObject() : row
}

/* Builds a reply that threads under the summoning message, in the channel it came from.
   Threading keeps each recap attached to the question that asked for it. An optional
   card turns the plain reply into the rendered engagement summary. */
function reply(
  context,
  parent: AgentResponse<string>['parent'],
  message: string,
  card?: { responseKind: string; renderData: unknown; metricsContext?: unknown }
): AgentResponse<string> {
  const channels = context.conversation.channels.filter((channel) => channel.name === SUMMON_CHANNEL)
  return { visible: true, message, messageType: 'text', channels, parent, ...card }
}

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

/* Builds the "which one did you mean?" reply, carrying the candidate list on the message itself
   (responseKind 'eventDisambiguation' + metricsContext) so a bare threaded reply naming one of
   the options can be resolved against this exact list rather than reclassified from scratch. */
function ambiguousReply(
  context,
  parent: AgentResponse<string>['parent'],
  candidates: EventCandidate[]
): AgentResponse<string> {
  return reply(context, parent, ambiguousMessage(candidates), {
    responseKind: 'eventDisambiguation',
    renderData: null,
    metricsContext: candidates
  })
}

/* The reply when a trend was asked for but there is nothing to compare: no stored snapshots and
   no past events to recompute live either. This is the genuinely-empty case (a space with fewer
   than two past public events), not the "snapshots not seeded yet" case, which the live recompute
   now covers. */
export function noTrendDataMessage(): string {
  return "I don't have any past events to compare there yet. Once an event has wrapped up, I can read it and start building a trend."
}

/* The reply when a host named specific events to compare and none of them matched a real public
   event. Lists recent public events to pick from instead, the same way notFoundMessage does for
   a single-event miss. */
export function namedTrendNotFoundMessage(names: string[], recent: EventCandidate[]): string {
  const quoted = names.map((name) => `"${name}"`).join(', ')
  if (recent.length === 0) {
    return `I couldn't find any events matching ${quoted}, and I don't have any public events to recap yet.`
  }
  const list = recent.map((candidate) => `• ${candidate.name}`).join('\n')
  return `I couldn't find any events matching ${quoted}. Recent public events:\n${list}`
}

/* A short note naming any event the host asked to compare that did not match a real public
   event, so a partial named-subset trend still says which name came up empty rather than
   silently dropping it. Null when every name resolved. */
function unresolvedEventsNote(unresolved: string[]): string | null {
  if (unresolved.length === 0) return null
  const quoted = unresolved.map((name) => `"${name}"`).join(', ')
  return `Couldn't find an event matching ${quoted}.`
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

/* The reply to a question whose interpretive half (what was said, what people thought, how a
   moment landed) VA cannot read from its own numbers. Points to the Event Historian only when
   one is actually installed on this conversation, so VA never references a capability that is
   not there; otherwise it says plainly that it has no way to read that. */
export function interpretiveDeferMessage(hasHistorian: boolean): string {
  if (hasHistorian) {
    return "That's about what was actually said, not something I can read from the numbers. The Event Historian can help with that."
  }
  return "That's a question for the Event Historian, out of scope for my data analysis. There's no Event Historian in this channel: add one here, or ask in a channel that already has one, for a more informed answer."
}

/* Appends an honest note about the interpretive half of a mixed question after answering its
   numeric half: a pointer to the Event Historian when one is installed, or the same actionable
   nudge to add or ask one elsewhere when there isn't one, rather than silently dropping that half. */
export function withHistorianPointer(answerText: string, hasHistorian: boolean): string {
  if (hasHistorian) return `${answerText} For what was actually said, the Event Historian can help with the rest.`
  return `${answerText} For what was actually said, that's a question for the Event Historian: there's none in this channel, so add one here or ask in a channel that already has one.`
}

/* The reply when a question was classified as answerable from the numbers, but the answerer
   still could not work one out from this event's own metrics (an edge the classifier missed).
   Points back to a full recap instead of a dead end. */
export function unanswerableQuestionMessage(eventName: string): string {
  return `I couldn't work out an answer to that from ${eventName}'s numbers. Ask for a recap and I'll show what I've got.`
}

const SmallTalkSchema = z.object({
  text: z.string().describe('One short, in-voice Slack reply that fits why the message was sent')
})

/* The static reply for each non-recap intent, used when the smalltalk model call fails, so a
   slow or erroring model never leaves someone with no reply at all. */
function staticSmallTalkFallback(intent: 'greeting' | 'help' | 'offTopic', recent: EventCandidate[]): string {
  if (intent === 'greeting') return greetingMessage(recent)
  if (intent === 'help') return helpMessage(recent)
  return offTopicMessage()
}

/* Writes an in-voice reply for a greeting, a help question, or an off-topic message, instead of
   always returning the same fixed sentence. Runs on the main model rather than the fast
   classification one, since wording quality and variation are the whole point here. Falls back
   to the static reply on any model failure, so a timeout or error never leaves the asker
   without a response. */
export async function smallTalkReply(
  intent: 'greeting' | 'help' | 'offTopic',
  message: string,
  recent: EventCandidate[],
  llm
): Promise<string> {
  try {
    const response = (await getChatPromptResponse(
      llm,
      VIBES_SMALLTALK_SYSTEM_PROMPT,
      VIBES_SMALLTALK_USER_TEMPLATE,
      { intent, message, recentEventsJson: JSON.stringify(recent.map((candidate) => candidate.name)) },
      undefined,
      SmallTalkSchema
    )) as z.infer<typeof SmallTalkSchema>
    return response.text
  } catch (error: unknown) {
    logger.warn(
      `Vibes Analyst smalltalk reply failed, falling back to a static reply: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return staticSmallTalkFallback(intent, recent)
  }
}

/* Re-checks read access for a resolved event before its data is used, failing closed: anything
   but an explicit public topic is refused. Returns a refusal message when access is denied, or
   null when the event may be read. Shared by the recap path and the on-demand question path,
   since both load and read a live event by id rather than trusting the candidate list alone. */
function accessDeniedMessage(context, conversation): string | null {
  const topic = conversation.topic as { _id?: { toString(): string }; private?: boolean } | undefined
  try {
    access.assertCanRead(context, {
      type: 'conversation',
      id: conversation._id.toString(),
      topicId: topic?._id?.toString(),
      topicIsPrivate: topic?.private !== false
    })
    return null
  } catch (error: unknown) {
    logger.warn(
      `Vibes Analyst refused summon for ${conversation._id}: ${error instanceof Error ? error.message : String(error)}`
    )
    return `I can only recap public events, and "${conversation.name}" isn't one I can share.`
  }
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

  const denied = accessDeniedMessage(context, conversation)
  if (denied) return [reply(context, parent, denied)]

  // A summon recaps a past event on demand. Only the auto path persists a metrics snapshot
  // (an event is snapshotted once, when it ends), so the metrics computed here are not written
  // to the snapshot store; they are still shaped the same quote-free way and carried alongside
  // the card so a thread reply can answer a follow-up question about this recap's numbers.
  const { renderData, metrics } = await buildVibesSummary(conversation, llm, fastLlm)
  const metricsContext = [buildSnapshotPayload(conversation, metrics)]
  // Fallback text for adapters that do not render the card (e.g. zoom); the card itself
  // rides along as responseKind + renderData for adapters that do (Slack).
  return [
    reply(context, parent, `Vibes summary for *${conversation.name}*`, {
      responseKind: 'curatedVibesSummary',
      renderData,
      metricsContext
    })
  ]
}

/**
 * Answers a cross-event trend question. When the host named specific events to compare
 * (reference.eventNames), scopes to exactly those, resolved by fuzzy title match; otherwise
 * scopes to the named series or all public events, taking the most recent N, same as before. It
 * prefers stored snapshots, and when too few exist to compare (a fresh deploy, or events that
 * ended before the snapshot write shipped) it recomputes the scoped events live instead of
 * dead-ending, so a trend still answers when the data exists but was never snapshotted. Live
 * rows are used for the WHOLE comparison rather than mixed with stored ones, so every event is
 * measured the same way. Either source is confined to the privacy-filtered candidate set, so a
 * private event can never enter a trend. With nothing to compare it says so; with exactly one
 * event it falls back to a normal single-event recap, since one event is not a trend. A named
 * event that failed to resolve is never silently dropped: it is noted alongside whatever the
 * comparison still produces from the rest.
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
  const eventNames = reference.eventNames ?? []
  let scoped: EventCandidate[]
  let unresolvedNote: string | null = null

  if (eventNames.length > 0) {
    const { resolved, unresolved } = resolveNamedTrendScope(eventNames, candidates)
    if (resolved.length === 0) {
      return [reply(context, parent, namedTrendNotFoundMessage(unresolved, recent))]
    }
    scoped = resolved.slice(0, MAX_TREND_EVENTS)
    unresolvedNote = unresolvedEventsNote(unresolved)
  } else {
    scoped = resolveTrendScope(reference, candidates)
  }

  // A named list is compared in full; a topic or "everything" scope still takes the requested
  // (or default) most-recent count.
  const limit = eventNames.length > 0 ? scoped.length : trendEventCount(reference)
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
    const message = unresolvedNote ? `${unresolvedNote} ${noTrendDataMessage()}` : noTrendDataMessage()
    return [reply(context, parent, message)]
  }
  if (views.length === 1) {
    const responses = await recapResolvedEvent(
      context,
      parent,
      views[0].conversationId.toString(),
      reference.eventQuery,
      recent,
      llm,
      fastLlm
    )
    if (unresolvedNote) responses[0] = { ...responses[0], message: `${unresolvedNote} ${responses[0].message}` }
    return responses
  }

  const renderData = await buildTrendSummary(views, llm)
  const metricsContext = views.map(plainMetricsRow)
  const message = unresolvedNote
    ? `${unresolvedNote} Engagement trend across recent events`
    : 'Engagement trend across recent events'
  return [
    reply(context, parent, message, {
      responseKind: 'curatedVibesSummary',
      renderData,
      metricsContext
    })
  ]
}

/**
 * Answers a message the intent classifier could not place, on the chance it is a genuine
 * follow-up question about a card VA already posted in this thread ("so that's 3 posters and 3
 * lurkers?"), rather than something truly off-topic. Only threaded replies are considered: a
 * fresh, unthreaded message has nothing to follow up on. Returns null (so the caller falls back
 * to the canned off-topic reply) when the message is not threaded, no ancestor card in the
 * thread carries metrics context, or the question turns out not to be answerable from that
 * card's numbers.
 */
async function tryFollowUp(
  context,
  parent: AgentResponse<string>['parent'],
  userMessage,
  llm
): Promise<AgentResponse<string> | null> {
  const conversationId = context.conversation._id.toString()
  const metricsContext = await resolveFollowUpContext(userMessage, conversationId)
  if (!metricsContext) return null

  const answer = await answerFollowUp(userMessage.body ?? '', metricsContext, llm)
  if (!answer.answerable || !answer.text) return null

  return reply(context, parent, answer.text)
}

/**
 * Answers a specific question about one event, rather than a general recap. Resolves the event
 * the same way a recap does (a named title, a topic's latest, or the single latest overall), then
 * branches on scope: "interpretive" defers outright to the Event Historian (when one is installed
 * on this conversation) rather than guessing at content VA never reads; "quantitative" and "mixed"
 * compute this event's metrics live and answer through the same answerFollowUp pass a threaded
 * follow-up question already uses, so a first, unthreaded question gets identical treatment to a
 * reply under a posted card. A mixed question's interpretive half is only ever pointed at the
 * historian (or honestly disclaimed when there isn't one), never guessed at from the metrics.
 */
async function handleQuestionSummon(
  context,
  parent: AgentResponse<string>['parent'],
  userMessage,
  reference: EventReference,
  candidates: EventCandidate[],
  recent: EventCandidate[],
  llm
): Promise<AgentResponse<string>[]> {
  if (!(reference.eventQuery ?? '').trim() && !reference.latestOverall && !reference.latestInTopic) {
    return [reply(context, parent, helpMessage(recent))]
  }

  const resolution = resolveSummonedEvent(reference, candidates)
  if (resolution.status === 'notFound') {
    return [reply(context, parent, notFoundMessage(reference.eventQuery, recent))]
  }
  if (resolution.status === 'ambiguous') {
    return [ambiguousReply(context, parent, resolution.candidates)]
  }

  const conversation = await Conversation.findById(resolution.event.id).populate('topic')
  if (!conversation) {
    return [reply(context, parent, notFoundMessage(reference.eventQuery, recent))]
  }
  const denied = accessDeniedMessage(context, conversation)
  if (denied) return [reply(context, parent, denied)]

  const hasHistorian = await hasHistorianAgent(conversation)

  if (reference.scope === 'interpretive') {
    return [reply(context, parent, interpretiveDeferMessage(hasHistorian))]
  }

  const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
  const metricsContext = [buildSnapshotPayload(conversation, metrics, { receptionCount: null })]
  const answer = await answerFollowUp(userMessage.body ?? '', metricsContext, llm)

  if (!answer.answerable || !answer.text) {
    return [reply(context, parent, unanswerableQuestionMessage(conversation.name))]
  }

  const text = reference.scope === 'mixed' ? withHistorianPointer(answer.text, hasHistorian) : answer.text
  return [reply(context, parent, text)]
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
  const conversationId = context.conversation._id.toString()

  // Parsing the message, loading the candidate events, and checking for a pending disambiguation
  // are all independent, so run them at once. The parse is a mechanical classification, so it
  // runs on the faster model; the other two are DB reads that take no model at all. The parse
  // still runs even when this turns out to answer a disambiguation (see below): it is cheap, and
  // running it unconditionally keeps the common path exactly as fast as before.
  const [reference, candidates, pendingCandidates] = await Promise.all([
    extractEventReference(userMessage.body ?? '', fastLlm),
    findCandidatePublicEvents(),
    resolveDisambiguationContext(userMessage, conversationId)
  ])

  // Newest first, capped, so a miss can suggest real recent events instead of dead-ending.
  const recent = [...candidates].sort((a, b) => b.endTime.getTime() - a.endTime.getTime()).slice(0, MAX_RECENT_SUGGESTIONS)

  // A threaded reply to VA's own "which one did you mean?" list is resolved against that exact
  // list, not the full candidate set or the intent classifier: a bare reply naming one of the
  // options ("Test Fancy Vibes #3") reads as unaddressed small talk to extractEventReference,
  // since it has no thread context of its own and the reply itself asks nothing. When the reply
  // doesn't match any listed option, fall through below in case it's a fresh, unrelated request.
  if (pendingCandidates) {
    const pendingResolution = resolveSummonedEvent(
      { eventQuery: userMessage.body ?? '', latestInTopic: false },
      pendingCandidates
    )
    if (pendingResolution.status === 'resolved') {
      return recapResolvedEvent(context, parent, pendingResolution.event.id, userMessage.body ?? '', recent, llm, fastLlm)
    }
    if (pendingResolution.status === 'ambiguous') {
      return [ambiguousReply(context, parent, pendingResolution.candidates)]
    }
  }

  // Addressed to VA but not asking for a recap: answer with an in-voice smalltalk reply rather
  // than resolving an event. Greeting and help both guide toward a recap; off-topic redirects,
  // unless this is a threaded reply under a card VA already posted, in which case it may be a
  // genuine follow-up question about that card's numbers rather than something truly off-topic.
  if (reference.intent === 'greeting') {
    return [reply(context, parent, await smallTalkReply('greeting', userMessage.body ?? '', recent, llm))]
  }
  if (reference.intent === 'help') {
    return [reply(context, parent, await smallTalkReply('help', userMessage.body ?? '', recent, llm))]
  }
  if (reference.intent === 'question') {
    return handleQuestionSummon(context, parent, userMessage, reference, candidates, recent, llm)
  }
  if (reference.intent === 'offTopic') {
    const followUp = await tryFollowUp(context, parent, userMessage, llm)
    if (followUp) return [followUp]
    return [reply(context, parent, await smallTalkReply('offTopic', userMessage.body ?? '', recent, llm))]
  }

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
    return [ambiguousReply(context, parent, resolution.candidates)]
  }

  return recapResolvedEvent(context, parent, resolution.event.id, reference.eventQuery, recent, llm, fastLlm)
}
