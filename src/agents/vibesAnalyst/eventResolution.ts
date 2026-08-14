import * as fuzzball from 'fuzzball'
import { z } from 'zod'
import Conversation from '../../models/conversation.model.js'
import ConversationMetricsSnapshot from '../../models/conversationMetricsSnapshot.model.js'
import conversationAnalyticsService, { METRICS_VERSION } from '../../services/conversationAnalytics.service.js'
import { buildSnapshotPayload } from '../../services/conversationMetricsSnapshot.service.js'
import { ConversationMetricsSnapshotData } from '../../types/index.types.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { VIBES_EVENT_REFERENCE_SYSTEM_PROMPT, VIBES_EVENT_REFERENCE_USER_TEMPLATE } from './prompt.js'

/* One past public event the summon could resolve to. */
export interface EventCandidate {
  id: string
  name: string
  topicName: string
  endTime: Date
}

/* Why the message addressed VA: recap an event, ask something specific about one, a
   greeting/liveness check, a help or capability question, or something off-topic. "recap" and
   "question" both read an event; the rest get a canned reply. Optional so callers that predate
   intent classification default to a recap. */
export type SummonIntent = 'recap' | 'question' | 'greeting' | 'help' | 'offTopic'

/* For a "question" intent, whether it is answerable from VA's own computed numbers
   ("quantitative"), about the content or meaning of what happened instead ("interpretive"), or
   both in the same message ("mixed"). Only meaningful when intent is "question"; null otherwise. */
export type SummonScope = 'quantitative' | 'interpretive' | 'mixed'

/* What the user asked for, extracted from their summon message: the text naming the
   event (a title, or a topic when they want its latest), and which "most recent" shortcut
   they used, if any. latestInTopic means the newest event in a named topic; latestOverall
   means the single newest event with no event or topic named ("the last event").

   trend is set when the user asks about several events at once or how something changed over
   time ("how was engagement across the last 3 events?"), which is answered from snapshots
   rather than one live recap. eventCount is how many recent events they named (null when
   unspecified). eventNames carries a specific list of events to compare when the user named
   more than one by title rather than a topic or "the last N" ("compare the Spring Town Hall to
   the AI Ethics kickoff"); empty otherwise, and mutually exclusive with eventQuery for a trend.
   intent is why they addressed VA at all; when it is neither "recap" nor "question" the event
   fields are empty. scope only applies to a "question" intent: whether it is answerable from
   the numbers, about content instead, or both; null for every other intent.
   All are optional so callers that only resolve a single event need not set them. */
export interface EventReference {
  eventQuery: string
  latestInTopic: boolean
  latestOverall?: boolean
  trend?: boolean
  eventCount?: number | null
  eventNames?: string[]
  intent?: SummonIntent
  scope?: SummonScope | null
}

/* The outcome of matching a reference against the public events on offer. */
export type EventResolution =
  | { status: 'resolved'; event: EventCandidate }
  | { status: 'ambiguous'; candidates: EventCandidate[] }
  | { status: 'notFound' }

/* A title has to score at least this (fuzzy, 0-100) to count as a match at all. */
const MATCH_THRESHOLD = 70
/* When two titles both clear the threshold, the top one wins outright only if it leads
   the runner-up by this much; otherwise the result is ambiguous and the caller asks. */
const AMBIGUITY_MARGIN = 15
/* At most this many options are offered back when a summon is ambiguous. */
const MAX_AMBIGUOUS = 5

/* Scores how well a query matches a title. token_set_ratio is forgiving of word order
   and of a query that is a subset of the full title ("Town Hall" vs "Spring Town Hall
   2026"), which is how people tend to refer to events. */
function titleScore(query: string, name: string): number {
  return fuzzball.token_set_ratio(query, name)
}

/* Resolves "the latest in a topic": the most recent event whose topic matches the
   query. No ambiguity here, since the newest one always wins. */
function resolveLatestInTopic(query: string, candidates: EventCandidate[]): EventResolution {
  const inTopic = candidates.filter((candidate) => titleScore(query, candidate.topicName) >= MATCH_THRESHOLD)
  if (inTopic.length === 0) return { status: 'notFound' }

  const newest = inTopic.reduce((latest, candidate) => (candidate.endTime > latest.endTime ? candidate : latest))
  return { status: 'resolved', event: newest }
}

/**
 * Matches a summon reference against the public events on offer. A query that exactly matches
 * one event's title (case and surrounding whitespace aside) resolves to it outright, without
 * weighing it against fuzzy scores at all: two events that share every word but a trailing
 * number or counter ("Test Fancy Vibes #1" vs "#3") fuzzy-score close enough behind an exact
 * match that the ambiguity margin alone can misfire on a query that was never actually
 * ambiguous. Only when more than one event shares the exact same title does that case still
 * report ambiguous, since then the query genuinely does not pick one over the other. Otherwise
 * a titled request fuzzy-ranks candidates by name: a single clear winner resolves, several close
 * matches come back as ambiguous (so the caller can ask which), and nothing close enough is
 * notFound. For a "latest in [topic]" request it returns the most recent event in the matching
 * topic.
 */
export function resolveSummonedEvent(reference: EventReference, candidates: EventCandidate[]): EventResolution {
  if (reference.latestOverall) {
    if (candidates.length === 0) return { status: 'notFound' }
    const newest = candidates.reduce((latest, candidate) => (candidate.endTime > latest.endTime ? candidate : latest))
    return { status: 'resolved', event: newest }
  }
  if (reference.latestInTopic) return resolveLatestInTopic(reference.eventQuery, candidates)

  const normalizedQuery = reference.eventQuery.trim().toLowerCase()
  const exactMatches = candidates.filter((candidate) => candidate.name.trim().toLowerCase() === normalizedQuery)
  if (exactMatches.length === 1) return { status: 'resolved', event: exactMatches[0] }
  if (exactMatches.length > 1) return { status: 'ambiguous', candidates: exactMatches.slice(0, MAX_AMBIGUOUS) }

  const ranked = candidates
    .map((candidate) => ({ candidate, score: titleScore(reference.eventQuery, candidate.name) }))
    .filter((scored) => scored.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0) return { status: 'notFound' }
  if (ranked.length === 1 || ranked[0].score - ranked[1].score >= AMBIGUITY_MARGIN) {
    return { status: 'resolved', event: ranked[0].candidate }
  }

  return { status: 'ambiguous', candidates: ranked.slice(0, MAX_AMBIGUOUS).map((scored) => scored.candidate) }
}

/* How many recent events a trend compares when the user does not say. */
export const DEFAULT_TREND_EVENTS = 5
/* The most a trend ever compares, so a vague "how have things been going?" cannot pull an
   unbounded run of snapshots into one card, and so a long named list still fits Slack's
   data_visualization chart limits (see trendSummary.ts). */
export const MAX_TREND_EVENTS = 10

/* Picks which public events a trend query covers. When the query names a topic that matches
   a series, the trend is scoped to that series; otherwise it falls back to every public event,
   newest first, so a generic "the last few events" still answers. Candidates arrive already
   sorted newest-first, and that order is preserved so the caller can take the most recent N.
   Pure over the privacy-filtered candidates, so a private series can never enter scope. */
export function resolveTrendScope(reference: EventReference, candidates: EventCandidate[]): EventCandidate[] {
  const query = reference.eventQuery.trim()
  if (query) {
    const inTopic = candidates.filter((candidate) => titleScore(query, candidate.topicName) >= MATCH_THRESHOLD)
    if (inTopic.length > 0) return inTopic
  }
  return candidates
}

/* Resolves a trend scoped to specific named events rather than a topic or "everything". Each
   name is fuzzy-matched the same way a single-event summon is: the best-scoring candidate wins
   when it clears MATCH_THRESHOLD, with no per-name disambiguation prompt, since asking the host
   to disambiguate every name in a multi-event compare would be worse than picking the closest
   match. A name that clears no candidate is reported back as unresolved rather than silently
   dropped, so the caller can say which one came up empty. Resolved events are deduped by id and
   keep the order they were named in, in case two names coincidentally resolve to the same event
   or the host repeats one. */
export function resolveNamedTrendScope(
  eventNames: string[],
  candidates: EventCandidate[]
): { resolved: EventCandidate[]; unresolved: string[] } {
  const resolved: EventCandidate[] = []
  const seenIds = new Set<string>()
  const unresolved: string[] = []

  for (const name of eventNames) {
    const best = candidates
      .map((candidate) => ({ candidate, score: titleScore(name, candidate.name) }))
      .filter((scored) => scored.score >= MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score)[0]

    if (!best) {
      unresolved.push(name)
      continue
    }
    if (!seenIds.has(best.candidate.id)) {
      seenIds.add(best.candidate.id)
      resolved.push(best.candidate)
    }
  }

  return { resolved, unresolved }
}

/* Resolves how many events to compare: the requested count, the default when none was given,
   clamped to at least one and at most MAX_TREND_EVENTS. */
export function trendEventCount(reference: EventReference): number {
  const requested = reference.eventCount ?? DEFAULT_TREND_EVENTS
  return Math.min(Math.max(1, requested), MAX_TREND_EVENTS)
}

/* Loads the stored metrics snapshots for a trend, newest first and capped at the limit. It
   reads only snapshots whose conversation is in the scoped (public) candidate set, so the
   privacy filter the candidates already passed carries through: a private event's snapshot can
   never be read here. Only the current metrics version is read, so a trend never compares
   numbers whose definitions changed underneath it. */
export async function fetchTrendSnapshots(scopedCandidates: EventCandidate[], limit: number) {
  const conversationIds = scopedCandidates.map((candidate) => candidate.id)
  return ConversationMetricsSnapshot.find({
    conversationId: { $in: conversationIds },
    metricsVersion: METRICS_VERSION
  })
    .sort({ endTime: -1 })
    .limit(limit)
}

/* Computes trend rows live for the scoped events, for the case where too few snapshots exist to
   compare (a fresh deploy, or events that ended before the snapshot write shipped). It recomputes
   each event's metrics with the same service the recap and snapshot use, then shapes them with
   buildSnapshotPayload so the rows are identical to a stored snapshot. The metrics are current
   definition, so a caller uses these for the WHOLE comparison rather than mixing them with stored
   snapshots at a possibly older version. The candidates arrive newest-first and privacy-filtered,
   so that order and filter carry through here just as they do for the stored read. The scalar
   recompute never runs the LLM reception pass, so receptionCount is recorded as null ("not
   computed") rather than a misleading 0, matching the backfill. */
export async function computeTrendViewsLive(
  scopedCandidates: EventCandidate[],
  limit: number
): Promise<ConversationMetricsSnapshotData[]> {
  const targets = scopedCandidates.slice(0, limit)
  // Each event's recompute is independent, so run them at once. A candidate that no longer
  // exists yields null and is dropped afterward, so a deleted event skips rather than fails.
  // Promise.all preserves order, so the newest-first candidate order carries through.
  const views = await Promise.all(
    targets.map(async (candidate) => {
      const conversation = await Conversation.findById(candidate.id).populate('topic')
      if (!conversation) return null
      const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
      return buildSnapshotPayload(conversation, metrics, { receptionCount: null })
    })
  )
  return views.filter((view): view is ConversationMetricsSnapshotData => view !== null)
}

/* At most this many recent public events are pulled as candidates. The summon matches
   by name in memory, so this bounds the work; very old events past the window are not
   summonable, which is an acceptable first cut. */
const MAX_CANDIDATES = 500

/**
 * Keeps only the events a summon is allowed to resolve to, and shapes them for matching.
 * An event qualifies when its topic populated and is explicitly public and it has ended.
 * Failing closed on the topic matters here: a private or unresolved topic is dropped, so
 * a private event's title can never surface in a disambiguation prompt.
 */
export function toPublicCandidates(
  conversations: {
    _id: { toString(): string }
    name: string
    endTime?: Date
    topic?: { name?: string; private?: boolean }
  }[]
): EventCandidate[] {
  return conversations
    .filter((conversation) => conversation.topic?.private === false && conversation.endTime instanceof Date)
    .map((conversation) => ({
      id: conversation._id.toString(),
      name: conversation.name,
      topicName: conversation.topic?.name ?? '',
      endTime: conversation.endTime as Date
    }))
}

/* Loads the recent public, ended events the summon can resolve to. The privacy filter
   lives in toPublicCandidates so it stays unit-tested; this just supplies the rows. */
export async function findCandidatePublicEvents(): Promise<EventCandidate[]> {
  const conversations = await Conversation.find({ endTime: { $ne: null } })
    .populate('topic')
    .select('name endTime topic')
    .sort({ endTime: -1 })
    .limit(MAX_CANDIDATES)

  return toPublicCandidates(conversations as Parameters<typeof toPublicCandidates>[0])
}

/* The shape the summon parser returns: the identifying words and whether the user asked
   for the latest in a topic. Re-validated against real events afterward. */
const EventReferenceSchema = z.object({
  intent: z
    .enum(['recap', 'question', 'greeting', 'help', 'offTopic'])
    .describe(
      'Why the message addressed the assistant: "recap" to summarize or compare past events, "question" to ask something specific about one (a number, a fact, an opinion, or what was said), "greeting" for a hello or liveness check, "help" for a what-can-you-do question, "offTopic" for anything else'
    ),
  eventQuery: z
    .string()
    .describe('Only the words that name the event or its topic, with the assistant mention and filler removed'),
  latestInTopic: z
    .boolean()
    .describe('True when they asked for the most recent event in a named topic rather than a specific named one'),
  latestOverall: z
    .boolean()
    .describe('True when they asked for the single most recent event overall, naming no event or topic'),
  trend: z
    .boolean()
    .describe('True when they asked about several events or how something changed over time, not one specific event'),
  eventCount: z
    .number()
    .nullable()
    .describe('How many recent events to compare when trend is true (e.g. "last 3" gives 3); null when unspecified'),
  eventNames: z
    .array(z.string())
    .describe(
      'When trend is true and the user named two or more specific events to compare (not a topic and not "the last N"), the identifying words for each one, one entry per event; empty otherwise'
    ),
  scope: z
    .enum(['quantitative', 'interpretive', 'mixed'])
    .nullable()
    .describe(
      'Only set when intent is "question": "quantitative" when answerable from computed engagement numbers, "interpretive" when about content or meaning instead, "mixed" when both. Null for every other intent.'
    )
})

/* Asks the model which past event a summon message is referring to. */
export async function extractEventReference(message: string, llm): Promise<EventReference> {
  return (await getChatPromptResponse(
    llm,
    VIBES_EVENT_REFERENCE_SYSTEM_PROMPT,
    VIBES_EVENT_REFERENCE_USER_TEMPLATE,
    { message },
    undefined,
    EventReferenceSchema
  )) as EventReference
}
