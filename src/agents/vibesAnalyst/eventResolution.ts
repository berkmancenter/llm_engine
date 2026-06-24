import * as fuzzball from 'fuzzball'
import { z } from 'zod'
import Conversation from '../../models/conversation.model.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { VIBES_EVENT_REFERENCE_SYSTEM_PROMPT, VIBES_EVENT_REFERENCE_USER_TEMPLATE } from './prompt.js'

/* One past public event the summon could resolve to. */
export interface EventCandidate {
  id: string
  name: string
  topicName: string
  endTime: Date
}

/* What the user asked for, extracted from their summon message: the text naming the
   event (a title, or a topic when they want its latest), and which "most recent" shortcut
   they used, if any. latestInTopic means the newest event in a named topic; latestOverall
   means the single newest event with no event or topic named ("the last event"). */
export interface EventReference {
  eventQuery: string
  latestInTopic: boolean
  latestOverall?: boolean
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
 * Matches a summon reference against the public events on offer. For a titled request
 * it fuzzy-ranks candidates by name: a single clear winner resolves, several close
 * matches come back as ambiguous (so the caller can ask which), and nothing close
 * enough is notFound. For a "latest in [topic]" request it returns the most recent
 * event in the matching topic.
 */
export function resolveSummonedEvent(reference: EventReference, candidates: EventCandidate[]): EventResolution {
  if (reference.latestOverall) {
    if (candidates.length === 0) return { status: 'notFound' }
    const newest = candidates.reduce((latest, candidate) => (candidate.endTime > latest.endTime ? candidate : latest))
    return { status: 'resolved', event: newest }
  }
  if (reference.latestInTopic) return resolveLatestInTopic(reference.eventQuery, candidates)

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
  eventQuery: z
    .string()
    .describe('Only the words that name the event or its topic, with the assistant mention and filler removed'),
  latestInTopic: z
    .boolean()
    .describe('True when they asked for the most recent event in a named topic rather than a specific named one'),
  latestOverall: z
    .boolean()
    .describe('True when they asked for the single most recent event overall, naming no event or topic')
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
