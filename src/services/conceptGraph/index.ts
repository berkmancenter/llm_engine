import httpStatus from 'http-status'
import mongoose from 'mongoose'
import { traceable } from 'langsmith/traceable'
import logger from '../../config/logger.js'
import ApiError from '../../utils/ApiError.js'
import Conversation from '../../models/conversation.model.js'
import Message from '../../models/message.model.js'
import Poll from '../../models/poll.model/poll.js'
import PollChoice from '../../models/poll.model/choice.js'
import PollResponse from '../../models/poll.model/response.js'
import RealNameRegistry from '../../models/realNameRegistry.model.js'
import Topic from '../../models/topic.model.js'
import User from '../../models/user.model/user.model.js'
import Artifact from '../../models/artifact.model/artifact.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../models/artifact.model/conceptGraphArtifact.js'
import { getModelChat, coreLLMModel, coreLLMPlatform } from '../../agents/helpers/getModelChat.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import { computeParticipation, countChannelParticipants, computeAudienceEngagement } from '../conversationAnalytics.service.js'
import artifactService from '../artifact.service.js'
import { EXTRACTION_PROMPT, EXTRACTION_SCHEMA } from './prompt.js'
import { aliasedKey, assembleGraph, AssemblyReport, ExtractionResult, PollRefMap, SourceRefMap } from './assemble.js'
import { screenForIdentities } from './nameScreen.js'
import {
  knownConceptLabels,
  payloadToExtraction,
  resolveConceptAliases,
  KNOWN_CONCEPT_LIMIT,
  CONCEPT_CAP
} from './topicGraph.js'
import { applyRelinks, proposeRelinks } from './relink.js'
import { proposeConsolidations, ConsolidationCandidate } from './consolidate.js'
import { ConceptGraphPayload, IBaseUser } from '../../types/index.types.js'
import schedule from '../../jobs/schedule.js'

/*
 * Builds a ConceptGraphArtifact from an event that has finished.
 *
 * Runs from two places, both of which come through generateConceptGraph: automatically when
 * a conversation stops, via the conceptCartographer agent's conversationStopped handler, and
 * on demand from POST /v1/artifacts/generate. The logic lives here rather than in the agent
 * so the manual path is the same code, not a second implementation that drifts.
 *
 * Re-running is safe and is the intended way to redo a bad extraction: the write goes
 * through artifactService, so a second run appends version 2 to the existing artifact rather
 * than replacing version 1 or creating a duplicate. Both extractions stay readable and
 * comparable.
 */

/* The shared event record an attendee already saw. An allowlist, so a channel added later —
   a moderator backchannel, a DM — is excluded until someone decides otherwise. The graph is
   published to everyone holding the artifact passcode, so it must not be built from
   anything narrower than what the room itself saw. */
export const GRAPH_SOURCE_CHANNELS = ['transcript', 'chat'] as const

/* Rough character budget per model call. Deliberately conservative: the extraction returns
   structured output, and a chunk that overruns the window fails the whole call rather than
   degrading. */
const CHUNK_CHARS = 24_000

/* Below this there is nothing to map, and a graph of two nodes is worse than none. */
const MIN_SOURCE_CHARS = 400

interface GraphSources {
  /* Verbatim message bodies, for the quote checker to compare against. A poll line is never
     added here: it is organizer-authored/aggregate text, not a participant's own words, so it
     is not part of what the quote checker guards against being lifted unquoted. */
  texts: string[]
  /* Messages and polls, chronologically interleaved and tagged [m1], [m2].../[p1], [p2]...,
     which is what the model actually reads. */
  taggedLines: string[]
  /* Tag to message id, so a cited tag becomes real provenance. */
  sourceRefs: SourceRefMap
  /* Tag to poll id, the [p#] counterpart of sourceRefs. */
  pollRefs: PollRefMap
  /* Each poll's tag and bare question text, so a caller can pre-seed an origin prompt that
     guarantees the node exists even on a chunk where the model doesn't bother restating it. */
  polls: { tag: string; pollId: string; question: string }[]
  knownIdentities: string[]
}

/**
 * Formats one poll as the single line the extractor reads: the question, how much of the
 * room responded, and how the responses split. Pure and DB-free so the wording — especially
 * the participation framing — can be tested directly against known counts.
 *
 * @param attendeeCount The tracked headcount to phrase turnout against, or undefined when
 *   that count isn't trustworthy for this conversation (see loadPolls) — in which case the
 *   raw response count is reported on its own rather than paired with a denominator that
 *   might contradict it.
 */
export const formatPollLine = (
  question: string,
  choices: { text: string; count: number }[],
  attendeeCount: number | undefined
): string => {
  const totalResponses = choices.reduce((sum, c) => sum + c.count, 0)
  const tally =
    totalResponses > 0
      ? choices.map((c) => `${c.text} ${c.count} (${Math.round((c.count / totalResponses) * 100)}%)`).join(', ')
      : 'no responses recorded'
  const participationClause =
    attendeeCount !== undefined
      ? `${totalResponses} of ${attendeeCount} attendees responded`
      : `${totalResponses} response${totalResponses === 1 ? '' : 's'}`

  return `Poll (${participationClause}): "${question.trim()}" — ${tally}`
}

/* A poll folded into one line of the event record. Never gated on whether the poll has
   "closed" — generateConceptGraph only ever runs after the conversation itself is inactive
   (see respondPoll's own active-conversation guard in poll.service), so every poll belonging
   to it already has permanently final results. */
const loadPolls = async (
  conversation
): Promise<{ pollId: string; createdAt: Date; text: string; question: string }[]> => {
  const conversationId = new mongoose.Types.ObjectId(conversation._id.toString())
  const polls = (await Poll.find({ conversation: conversationId })
    .select('title createdAt')
    .lean()
    .exec()) as unknown as { _id: mongoose.Types.ObjectId; title: string; createdAt: Date }[]
  if (polls.length === 0) return []

  const pollIds = polls.map((p) => p._id)
  const [choices, responses] = await Promise.all([
    PollChoice.find({ poll: { $in: pollIds } }).select('poll text').lean().exec(),
    PollResponse.find({ poll: { $in: pollIds } }).select('poll choice').lean().exec()
  ])

  const choicesByPoll = new Map<string, { id: string; text: string }[]>()
  for (const choice of choices) {
    const key = choice.poll.toString()
    const list = choicesByPoll.get(key) ?? []
    list.push({ id: choice._id.toString(), text: choice.text })
    choicesByPoll.set(key, list)
  }
  const countByChoiceId = new Map<string, number>()
  for (const response of responses) {
    const key = response.choice.toString()
    countByChoiceId.set(key, (countByChoiceId.get(key) ?? 0) + 1)
  }

  /* The attendee denominator, computed once for the conversation and reused for every poll
     in it — see conversationAnalytics.service.ts. Trusted only when tracked participation
     actually reconciles with who posted (postersExceedTrackedSessions false) and there is a
     real tracked headcount to divide by (participantCount > 0); otherwise an "of N attendees"
     framing would either contradict the room's own poster count or imply a headcount that
     was never actually tracked, so the response count is reported on its own instead. */
  const participation = await computeParticipation(conversationId)
  const channelParticipantCount = await countChannelParticipants(conversation)
  const engagement = computeAudienceEngagement(participation.posterCount, channelParticipantCount)
  const attendeeCount =
    !engagement.postersExceedTrackedSessions && engagement.participantCount > 0 ? engagement.participantCount : undefined

  return polls.map((poll) => {
    const question = poll.title.trim()
    const pollChoices = (choicesByPoll.get(poll._id.toString()) ?? []).map((c) => ({
      text: c.text,
      count: countByChoiceId.get(c.id) ?? 0
    }))
    /* Poll voting isn't gated the same way message-posting participation is, so a
       specific poll's own response count can exceed the conversation-level attendeeCount
       above. Reconciled per poll rather than trusting the shared denominator everywhere:
       when a poll's own responses outnumber it, the count would contradict itself ("12 of
       10 attendees responded"), so that poll falls back to reporting its raw response
       count instead. */
    const totalResponses = pollChoices.reduce((sum, c) => sum + c.count, 0)
    const trustedAttendeeCount =
      attendeeCount !== undefined && totalResponses > attendeeCount ? undefined : attendeeCount
    return {
      pollId: poll._id.toString(),
      createdAt: poll.createdAt,
      text: formatPollLine(question, pollChoices, trustedAttendeeCount),
      question
    }
  })
}

/*
 * Every name a topic knows, for the attribution check.
 *
 * Scoped to the whole topic, never to one conversation, and that is a correctness
 * requirement rather than convenience. Session two can name someone who only ever spoke in
 * session one — an organizer, a returning participant — and a check that only knew session
 * two's roster would pass that name straight through. The union is the only list that makes
 * the Chatham House guarantee hold for a series, and it costs one extra query.
 *
 * Three registers, because a participant can appear under any of them: the pseudonym they
 * posted under, a real name reserved in RealNameRegistry when a conversation runs with real
 * names on, and the presenters and moderators named on each conversation record.
 */
const collectKnownIdentities = async (conversations): Promise<string[]> => {
  const identities = new Set<string>()
  const conversationIds = conversations.map((c) => c._id)

  for (const conversation of conversations) {
    for (const profile of [...(conversation.presenters ?? []), ...(conversation.moderators ?? [])]) {
      if (profile?.name) identities.add(profile.name)
      if (profile?.alternateName) identities.add(profile.alternateName)
    }
  }

  const reservations = await RealNameRegistry.find({ conversationId: { $in: conversationIds } })
    .select('normalizedPseudonym')
    .lean()
    .exec()
  for (const reservation of reservations)
    if (reservation.normalizedPseudonym) identities.add(reservation.normalizedPseudonym)

  /* Pseudonyms of everyone who posted anywhere in the topic. Read off the users rather than
     the messages so an inactive pseudonym still counts — a name is identifying whether or
     not it is the one currently displayed. */
  const posters = await Message.distinct('owner', { conversation: { $in: conversationIds } }).exec()
  if (posters.length > 0) {
    const users = await User.find({ _id: { $in: posters } })
      .select('pseudonyms.pseudonym')
      .lean()
      .exec()
    for (const user of users) for (const p of user.pseudonyms ?? []) if (p?.pseudonym) identities.add(p.pseudonym)
  }

  return [...identities]
}

/* Every conversation under a topic, with just the fields the identity union and loadSources'
   poll lookup need. */
const topicConversations = async (topicId) =>
  Conversation.find({ topic: topicId }).select('name presenters moderators topic agents channels').lean().exec()

/* One message or poll, ordered and tagged together. Pure and DB-free — see
   interleaveSources — so the ordering and tagging can be tested directly against synthetic
   timestamps rather than through a database. */
type SourceItem =
  | { kind: 'message'; createdAt: Date; body: string; messageId: string }
  | { kind: 'poll'; createdAt: Date; text: string; pollId: string; question: string }

/**
 * Interleaves messages and polls into one createdAt-ordered sequence and tags each line for
 * citation — a poll in the position it was actually posted, alongside the chat that led up
 * to and followed it, which is what lets a contribution attach to it. Messages and polls tag
 * independently ([m1], [m2]... / [p1], [p2]...) so a cited tag's prefix alone says which map
 * to resolve it against.
 */
export const interleaveSources = (items: SourceItem[]): Omit<GraphSources, 'knownIdentities'> => {
  const ordered = [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const texts: string[] = []
  const taggedLines: string[] = []
  const sourceRefs: SourceRefMap = new Map()
  const pollRefs: PollRefMap = new Map()
  const polls: { tag: string; pollId: string; question: string }[] = []
  let messageIndex = 0
  let pollIndex = 0
  for (const item of ordered) {
    if (item.kind === 'message') {
      messageIndex += 1
      const tag = `m${messageIndex}`
      texts.push(item.body)
      /* No speaker labels on these lines, deliberately. The model cannot reveal an identity
         it was never shown, which makes the Chatham House guarantee structural here rather
         than something the prompt has to talk it out of. */
      taggedLines.push(`[${tag}] ${item.body}`)
      sourceRefs.set(tag, item.messageId)
    } else {
      pollIndex += 1
      const tag = `p${pollIndex}`
      taggedLines.push(`[${tag}] ${item.text}`)
      pollRefs.set(tag, item.pollId)
      polls.push({ tag, pollId: item.pollId, question: item.question })
    }
  }

  return { texts, taggedLines, sourceRefs, pollRefs, polls }
}

/** The messages and polls one conversation contributes, interleaved chronologically and
    tagged for citation. */
const loadSources = async (conversation, knownIdentities: string[]): Promise<GraphSources> => {
  const messages = await Message.find({
    conversation: conversation._id,
    channels: { $in: [...GRAPH_SOURCE_CHANNELS] },
    visible: { $ne: false }
  })
    .sort({ createdAt: 1 })
    .select('body fromAgent createdAt')
    .lean()
    .exec()

  /* Agent messages are excluded: an assistant's own summaries and prompts are not the
     room's thinking, and mapping them would feed the model's earlier output back in as if
     participants had said it. */
  const usable = messages.filter((m) => !m.fromAgent && typeof m.body === 'string' && m.body.trim().length > 0)
  const polls = await loadPolls(conversation)

  const items: SourceItem[] = [
    ...usable.map(
      (m): SourceItem => ({
        kind: 'message',
        createdAt: m.createdAt as unknown as Date,
        body: (m.body as string).trim(),
        messageId: m._id!.toString()
      })
    ),
    ...polls.map(
      (p): SourceItem => ({ kind: 'poll', createdAt: p.createdAt, text: p.text, pollId: p.pollId, question: p.question })
    )
  ]

  return { ...interleaveSources(items), knownIdentities }
}

/* Packs whole messages into chunks, never splitting one, so a statement is always judged
   against the message it came from rather than half of it. */
export const chunkSources = (texts: string[], limit = CHUNK_CHARS): string[] => {
  const chunks: string[] = []
  let current = ''
  for (const text of texts) {
    if (current && current.length + text.length + 1 > limit) {
      chunks.push(current)
      current = ''
    }
    current = current ? `${current}\n${text}` : text
  }
  if (current) chunks.push(current)
  return chunks
}

const extractFromChunk = async (
  llm,
  chunk: string,
  conversationId: string,
  index: number,
  knownConcepts: string[] = []
): Promise<ExtractionResult> => {
  /* Tagged the way the stop-time summary is, so numberCruncher attributes this spend to the
     conversation it maps and groups it with the rest of the post-event work. */
  const result = await traceable(
    async () =>
      getChatPromptResponse(
        llm,
        EXTRACTION_PROMPT,
        'Concepts this series has already established:\n{knownConcepts}\n\nEvent record:\n\n{chunk}',
        {
          chunk,
          knownConcepts: knownConcepts.length > 0 ? knownConcepts.join('\n') : '(none — this is the first event mapped)'
        },
        undefined,
        EXTRACTION_SCHEMA
      ),
    { name: 'conceptGraphExtraction', metadata: { conversationId, costPhase: 'postEvent' as const, chunk: index } }
  )()
  return result as ExtractionResult
}

/* The series graph as it stands, for vocabulary and for relinking. */
const currentTopicGraph = async (topicId?: string) => {
  if (!topicId) return { artifact: null, payload: undefined as ConceptGraphPayload | undefined }
  const artifact = await Artifact.findOne({
    topic: topicId,
    scope: 'topic',
    __t: CONCEPT_GRAPH_ARTIFACT,
    isDeleted: { $ne: true }
  })
    .sort('createdAt')
    .populate('currentVersion')
    .exec()
  return { artifact, payload: (artifact?.currentVersion as { payload?: ConceptGraphPayload } | undefined)?.payload }
}

/*
 * Runs the model-based Chatham House screen over every piece of free text in an assembled
 * graph, and returns the graph with whatever it flagged removed.
 *
 * What gets removed is the smallest thing carrying the risk. A flagged statement costs its
 * sentence but keeps its edge — the relationship is structural information, while the prose
 * is the only part that can name someone. A flagged concept label or prompt text has no
 * safe remainder, so the node goes, and anything left dangling goes with it.
 *
 * Returns a new payload and a new report rather than editing the ones passed in, so the
 * pre-screen graph stays intact for logging and for anyone debugging what the screen took.
 */
const applyIdentityScreen = async (
  llm,
  payload: ConceptGraphPayload,
  conversationId: string,
  report: AssemblyReport
): Promise<{ payload: ConceptGraphPayload; report: AssemblyReport }> => {
  /* Screened together in one call, tracked by what each line came from so a flag can be
     turned back into the right removal. */
  const candidates: { text: string; kind: 'statement' | 'concept' | 'gloss' | 'prompt'; id: string }[] = [
    ...payload.contributions
      .filter((c) => c.statement)
      .map((c) => ({ text: c.statement!, kind: 'statement' as const, id: c.id })),
    ...payload.concepts.map((c) => ({ text: c.label, kind: 'concept' as const, id: c.id })),
    /* Free-form model prose, same risk category as a statement — screened the same way,
       and the same "smallest thing that carries the risk" rule applies: a flagged gloss
       costs its own sentence, not the concept it describes. */
    ...payload.concepts
      .filter((c) => c.gloss)
      .map((c) => ({ text: c.gloss!, kind: 'gloss' as const, id: c.id })),
    ...payload.originPrompts.map((p) => ({ text: p.text, kind: 'prompt' as const, id: p.id }))
  ]

  const flagged = await screenForIdentities(
    llm,
    candidates.map((c) => c.text),
    conversationId
  )
  if (flagged.size === 0) return { payload, report }

  const flaggedOf = (kind: string) =>
    new Set(
      [...flagged]
        .map((i) => candidates[i])
        .filter((c) => c?.kind === kind)
        .map((c) => c.id)
    )
  const unsafeStatements = flaggedOf('statement')
  const unsafeConcepts = flaggedOf('concept')
  const unsafeGlosses = flaggedOf('gloss')
  const unsafePrompts = flaggedOf('prompt')

  const concepts = payload.concepts
    .filter((c) => !unsafeConcepts.has(c.id))
    .map((c) => {
      const { origin, gloss, ...rest } = c
      return {
        ...rest,
        ...(gloss && !unsafeGlosses.has(c.id) && { gloss }),
        ...(origin && !unsafePrompts.has(origin) && { origin })
      }
    })
  const originPrompts = payload.originPrompts.filter((p) => !unsafePrompts.has(p.id))
  const contributions = payload.contributions
    .filter((k) => !k.concepts.some((id) => unsafeConcepts.has(id)))
    .map((k) => {
      const { statement, origin, ...rest } = k
      return {
        ...rest,
        ...(statement && !unsafeStatements.has(k.id) && { statement }),
        ...(origin && !unsafePrompts.has(origin) && { origin })
      }
    })

  return {
    payload: { concepts, contributions, originPrompts },
    report: {
      ...report,
      droppedConcepts: report.droppedConcepts + unsafeConcepts.size,
      droppedContributions: report.droppedContributions + (payload.contributions.length - contributions.length),
      droppedStatements: report.droppedStatements + unsafeStatements.size,
      droppedGlosses: report.droppedGlosses + unsafeGlosses.size,
      droppedOriginPrompts: report.droppedOriginPrompts + unsafePrompts.size
    }
  }
}

/**
 * Builds the graph for a finished conversation and writes it as an artifact version.
 *
 * @param conversationId The conversation to map.
 * @param caller The agent or user the write is attributed to; must be able to write
 *   artifacts for this conversation (see artifact.service's authorizeArtifactWrite).
 * @returns The artifact and the version written, or null when there was nothing to map.
 */
export const generateConceptGraph = async (conversationId: string, caller: IBaseUser) => {
  const conversation = await Conversation.findById(conversationId)
    .select('name presenters moderators topic agents channels')
    .lean()
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }

  /* Screened against every name the whole topic knows, not just this conversation's — see
     collectKnownIdentities. A conversation with no topic falls back to itself. */
  const siblings = conversation.topic ? await topicConversations(conversation.topic) : []
  const knownIdentities = await collectKnownIdentities(
    siblings.length > 0 ? siblings : [{ ...conversation, _id: conversationId }]
  )
  const { texts, taggedLines, sourceRefs, pollRefs, polls } = await loadSources(
    { ...conversation, _id: conversationId },
    knownIdentities
  )
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0)
  if (totalChars < MIN_SOURCE_CHARS) {
    logger.info(`conceptGraph: conversation ${conversationId} has too little content to map (${totalChars} chars)`)
    return null
  }

  const llm = await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 4000 })
  /* Offer this event the vocabulary the series has already built, so its contributions can
     reach concepts established before it rather than staying sealed inside this transcript.
     The topic refinement reuses this same extraction, so the crossings come through for free. */
  const topicIdForVocabulary = conversation.topic?.toString()
  const { payload: seriesPayload } = await currentTopicGraph(topicIdForVocabulary)
  const knownConcepts = knownConceptLabels(seriesPayload)
  const chunks = chunkSources(taggedLines)
  const results: ExtractionResult[] = []
  for (const [index, chunk] of chunks.entries()) {
    try {
      results.push(await extractFromChunk(llm, chunk, conversationId, index, knownConcepts))
    } catch (error) {
      /* One chunk failing costs that slice of the event, not the whole map. The graph is a
         summary, so a partial one is still worth writing — and the alternative is throwing
         away every chunk that did succeed. */
      logger.warn(`conceptGraph: chunk ${index} of ${chunks.length} failed for ${conversationId}: ${error}`)
    }
  }
  if (results.length === 0) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Concept graph extraction produced nothing')
  }

  /* Guarantees a poll's question becomes an origin prompt even on a chunk where the model
     didn't bother restating it — safe to double up with whatever the model itself produced,
     since promptIdByText's canonical-text dedup in assembleGraph collapses the two. */
  if (polls.length > 0) {
    results.unshift({
      concepts: [],
      contributions: [],
      originPrompts: polls.map((p) => ({ text: p.question, sourceRefs: [p.tag] }))
    })
  }

  const assembled = assembleGraph(
    results,
    { sourceTexts: texts, knownIdentities },
    { conversationId, sourceRefs, pollRefs }
  )

  /* The exact checks inside assembleGraph have run by here; this is the pass that catches
     what no list could — an unrecorded name, an identifying affiliation. Only the free text
     is screened, since ids carry no prose. */
  const { payload, report } = await applyIdentityScreen(llm, assembled.payload, conversationId, assembled.report)
  logger.info(
    `conceptGraph: ${conversationId} -> ${payload.concepts.length} concepts, ${payload.contributions.length} contributions, ` +
      `${payload.originPrompts.length} prompts (dropped ${report.droppedConcepts} concepts, ` +
      `${report.droppedContributions} contributions, ${report.droppedStatements} statements, ` +
      `${report.droppedOriginPrompts} prompts; merged ${report.mergedConcepts})`
  )

  if (payload.contributions.length === 0) {
    logger.info(`conceptGraph: nothing survived assembly for ${conversationId}, not writing an artifact`)
    return null
  }

  /* Append to this conversation's existing graph if it has one, so a re-run is version 2
     rather than a second artifact sitting beside the first. */
  const existing = await Artifact.findOne({
    conversation: conversationId,
    __t: CONCEPT_GRAPH_ARTIFACT,
    isDeleted: { $ne: true }
  })
    .sort('createdAt')
    .exec()

  const note = `Generated from ${texts.length} message${texts.length === 1 ? '' : 's'} in the event record`

  if (existing) {
    const version = await artifactService.appendVersion(existing._id!.toString(), { payload, note }, caller)
    return { artifact: existing, version, report, results, knownIdentities, texts, pollRefs }
  }

  const { artifact, version } = await artifactService.createArtifact(
    {
      type: CONCEPT_GRAPH_ARTIFACT,
      conversationId,
      title: `Concept map — ${conversation.name}`,
      description: 'Concepts the event turned on, and how the discussion related them. Generated after the event.',
      payload,
      note
    },
    caller
  )
  /* The raw extraction rides along so a topic refinement triggered by the same event can
     merge it without paying for the transcript to be read a second time. */
  return { artifact, version, report, results, knownIdentities, texts, pollRefs }
}

/**
 * Folds one event's understanding into its topic's graph, and saves the result as a version.
 *
 * A series unfolds over time, so the topic graph is refined rather than rebuilt: the
 * existing graph is read back into extraction form, merged with what is new, and written as
 * the next version. Each event therefore leaves one version behind, and the sequence of
 * versions is a record of how the series' understanding developed — which is the thing a
 * rebuild-from-scratch approach cannot give you at any price.
 *
 * @param topicId The topic whose graph to refine.
 * @param caller Agent or user the write is attributed to.
 * @param incoming Extraction already paid for by a conversation-level run, plus the source
 *   texts it was checked against. Omit to read every conversation in the topic from
 *   scratch, which is how a series that predates this feature gets backfilled.
 * @param options.reset Recompute from the raw transcripts alone, ignoring the graph's current
 *   version as a merge source. An ordinary re-run still folds the current version in — see
 *   `prior` below — which is right for redoing a bad extraction but means a past fold or a
 *   too-low CONCEPT_CAP can never be undone by just raising the cap and re-running: the
 *   folded concept's own node is gone, and only its label survives, on its survivor's
 *   `foldedFrom`. Reset exists for that one case, is never sent by the client, and is not
 *   meant to be routine — every conversation gets re-read and re-merged from nothing, so it
 *   costs what a full backfill costs. The pre-reset graph is never lost either way: this
 *   still writes through `appendVersion`, so it stays in the artifact's version history.
 */
export const refineTopicGraph = async (
  topicId: string,
  caller: IBaseUser,
  incoming?: {
    results: ExtractionResult[]
    texts: string[]
    knownIdentities: string[]
    conversationId?: string
    pollRefs?: PollRefMap
  },
  options?: { reset?: boolean }
) => {
  const reset = options?.reset ?? false
  if (reset) logger.info(`conceptGraph: topic ${topicId} resetting — recomputing from the raw transcripts alone`)
  const topic = await Topic.findOne({ _id: topicId, isDeleted: { $ne: true } })
    .select('name')
    .lean()
    .exec()
  if (!topic) throw new ApiError(httpStatus.NOT_FOUND, `Topic with id ${topicId} not found`)

  const conversations = await topicConversations(topicId)
  const knownIdentities = incoming?.knownIdentities ?? (await collectKnownIdentities(conversations))
  const llm = await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 4000 })

  let results: ExtractionResult[] = incoming?.results ?? []
  let texts: string[] = incoming?.texts ?? []

  /* Backfill path: no event handed us an extraction, so read the whole series. Deliberately
     the slow path — it exists for a topic whose events all predate this feature, not for the
     steady state, where each event contributes its own extraction as it ends. A reset always
     takes this path too, even on the (currently theoretical) chance it was called alongside
     an `incoming` extraction — resetting from anything less than the whole series would defeat
     the point of it. */
  if (reset || results.length === 0) {
    /* Walked in order, carrying the vocabulary forward: each conversation is offered what the
       earlier ones established, so a backfill builds the same crossings the incremental path
       would have built had the feature existed at the time. */
    const accumulated: string[] = []
    for (const conversation of conversations) {
      const sources = await loadSources(conversation, knownIdentities)
      if (sources.texts.length === 0) continue
      texts = [...texts, ...sources.texts]
      /* Guarantees each conversation's poll questions become origin prompts even where the
         model doesn't restate them — see the identical seed in generateConceptGraph. Carries
         provenance directly rather than a sourceRefs tag: each conversation's loadSources call
         has its own locally-scoped tag namespace (poll tags restart at "p1" every time), so
         merging every conversation's pollRefs into one map for this backfill's single
         assembleGraph call would collide across conversations. The pollId is already known
         here, so provenanceFor's carried-provenance fast path sidesteps that entirely. */
      if (sources.polls.length > 0) {
        results.push({
          concepts: [],
          contributions: [],
          originPrompts: sources.polls.map((p) => ({ text: p.question, provenance: { pollId: p.pollId } }))
        })
      }
      for (const [index, chunk] of chunkSources(sources.taggedLines).entries()) {
        try {
          const extracted = await extractFromChunk(
            llm,
            chunk,
            conversation._id.toString(),
            index,
            accumulated.slice(0, KNOWN_CONCEPT_LIMIT)
          )
          results.push(extracted)
          for (const concept of extracted.concepts ?? []) {
            if (concept.label && !accumulated.includes(concept.label)) accumulated.push(concept.label)
          }
        } catch (error) {
          logger.warn(`conceptGraph: topic ${topicId} chunk ${index} failed for ${conversation._id}: ${error}`)
        }
      }
    }
  }

  const { artifact: existing, payload: priorPayload } = await currentTopicGraph(topicId)

  /* The graph so far becomes just another extraction to merge, so one code path merges two
     chunks of a transcript and six sessions of a series. A reset deliberately leaves it out:
     `existing` is still carried through to `appendVersion` below, so the pre-reset graph
     survives as the previous version, but nothing about it feeds the recompute. */
  const prior = !reset && priorPayload ? payloadToExtraction(priorPayload) : undefined
  if (prior) results = [prior, ...results]

  if (results.length === 0) {
    logger.info(`conceptGraph: nothing to fold into the graph for topic ${topicId}`)
    return null
  }

  /* Canonical folding only catches spellings of one word. Across sessions months apart the
     same idea comes back in different words, and only a reader who understands both can say
     they are the same — so the merge is proposed here and applied deterministically below. */
  const labels = [...new Set(results.flatMap((r) => (r.concepts ?? []).map((c) => c.label)))]
  const aliases = await resolveConceptAliases(llm, labels, topicId)

  /*
   * Reconsider what the series already believed, now that this event has introduced concepts
   * it did not have. Run after alias resolution on purpose: a concept is only genuinely new if
   * it is not just a rewording of something the map already held, and asking before the
   * aliases are known would relink half the graph onto duplicates of itself.
   */
  if (prior) {
    const priorKeys = new Set((prior.concepts ?? []).map((c) => aliasedKey(c.label, aliases)))
    const newConceptLabels = [
      ...new Set(
        results
          .filter((r) => r !== prior)
          .flatMap((r) => (r.concepts ?? []).map((c) => c.label))
          .filter((label) => !priorKeys.has(aliasedKey(label, aliases)))
      )
    ]
    const relinked = applyRelinks(prior, await proposeRelinks(llm, prior, newConceptLabels, topicId))
    results = [...relinked, ...results.filter((r) => r !== prior)]
  }

  const assembled = assembleGraph(
    results,
    { sourceTexts: texts, knownIdentities },
    { aliases, conversationId: incoming?.conversationId, pollRefs: incoming?.pollRefs }
  )
  let { payload, report } = await applyIdentityScreen(llm, assembled.payload, topicId, assembled.report)

  logger.info(
    `conceptGraph: topic ${topicId} -> ${payload.concepts.length} concepts, ${payload.contributions.length} ` +
      `contributions across ${conversations.length} conversation(s) (merged ${report.mergedConcepts}, ` +
      `${aliases.length} alias group(s))`
  )

  if (payload.contributions.length === 0) {
    logger.info(`conceptGraph: nothing survived assembly for topic ${topicId}, not writing an artifact`)
    return null
  }

  /*
   * The graph is a picture someone looks at, not just a store of everything ever said, and a
   * series that runs long enough outgrows what a reader can take in on one canvas. Folding
   * runs here, on the finished payload, rather than earlier alongside alias resolution: it
   * needs the real, final degree of every concept — how many contributions actually touch it
   * — which only exists once assembly and the identity screen are both done.
   */
  if (payload.concepts.length > CONCEPT_CAP) {
    const degree = new Map<string, number>()
    for (const contribution of payload.contributions) {
      for (const id of contribution.concepts) degree.set(id, (degree.get(id) ?? 0) + 1)
    }
    const byDegreeAsc = [...payload.concepts].sort((a, b) => (degree.get(a.id) ?? 0) - (degree.get(b.id) ?? 0))
    const overBy = payload.concepts.length - CONCEPT_CAP
    const toCandidate = (c: (typeof payload.concepts)[number]): ConsolidationCandidate => ({
      label: c.label,
      gloss: c.gloss,
      degree: degree.get(c.id) ?? 0
    })
    const candidates = byDegreeAsc.slice(0, overBy).map(toCandidate)
    const central = byDegreeAsc.slice(overBy).map(toCandidate)

    const foldedGroups = await proposeConsolidations(llm, candidates, central, topicId)
    if (foldedGroups.length > 0) {
      /* The whole current payload becomes just another extraction to merge, the same trick
         `prior` already plays above — one code path folds concepts the same way it merges
         chunks of a transcript or sessions of a series. `aliases` is left empty: alias
         resolution has already run for this refinement, and this second pass exists only to
         apply the folds just proposed. */
      const folded = assembleGraph([payloadToExtraction(payload)], { sourceTexts: texts, knownIdentities }, { foldedGroups })
      payload = folded.payload
      report = {
        ...report,
        droppedConcepts: report.droppedConcepts + folded.report.droppedConcepts,
        droppedContributions: report.droppedContributions + folded.report.droppedContributions,
        droppedStatements: report.droppedStatements + folded.report.droppedStatements,
        droppedGlosses: report.droppedGlosses + folded.report.droppedGlosses,
        droppedOriginPrompts: report.droppedOriginPrompts + folded.report.droppedOriginPrompts,
        foldedConcepts: report.foldedConcepts + folded.report.foldedConcepts,
        mergedConcepts: report.mergedConcepts + folded.report.mergedConcepts
      }
      logger.info(
        `conceptGraph: topic ${topicId} folded ${folded.report.foldedConcepts} concept(s) into related ones, ` +
          `now ${payload.concepts.length}/${CONCEPT_CAP}`
      )
    }
  }

  const foldNote =
    report.foldedConcepts > 0
      ? ` — folded ${report.foldedConcepts} concept${report.foldedConcepts === 1 ? '' : 's'} into related ones to stay ` +
        `readable; see the previous version for each on its own`
      : ''
  const conversationCount = `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`
  let noteBody: string
  if (reset) {
    noteBody =
      `Recomputed from scratch across ${conversationCount}, ignoring the previous version's ` +
      `accumulated state — see it for the pre-reset graph`
  } else if (priorPayload) {
    noteBody = `Refined with one further conversation; ${conversations.length} in the series`
  } else {
    noteBody = `Built from ${conversationCount}`
  }
  const note = noteBody + foldNote

  if (existing) {
    const version = await artifactService.appendVersion(existing._id!.toString(), { payload, note }, caller)
    return { artifact: existing, version, report }
  }

  const { artifact, version } = await artifactService.createArtifact(
    {
      type: CONCEPT_GRAPH_ARTIFACT,
      topicId,
      title: `Concept map — ${topic.name}`,
      description: 'Concepts this series has turned on, and how its discussions related them. Refined after each event.',
      payload,
      note
    },
    caller
  )
  return { artifact, version, report }
}

/*
 * Claims (or creates) the target artifact and hands the actual generation off to a
 * background job (jobs/handlers/conceptGraph.ts), rather than running generateConceptGraph/
 * refineTopicGraph's LLM chain inline. POST /v1/artifacts/generate sits behind a load
 * balancer with a much shorter timeout than this pipeline can take
 * (infra/modules/webserver-mig/lb.tf), so a caller must never wait on either function
 * directly.
 *
 * The atomic claim below — flip generationStatus to 'pending', but only if it is not
 * already 'pending' — is the "claim before you act" guard jobs/CLAUDE.md asks for, and it
 * doubles as the only thing stopping two overlapping requests for the same artifact from
 * both starting a generation run and paying for the LLM calls twice. A generation already
 * in flight is a no-op: the caller gets the same, still-pending artifact back rather than a
 * second job.
 */
export const enqueueGeneration = async (
  { conversationId, topicId, reset }: { conversationId?: string; topicId?: string; reset?: boolean },
  caller: IBaseUser
) => {
  if (!!topicId === !!conversationId) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Provide exactly one of topicId or conversationId')
  }

  const container = await artifactService.resolveContainer({ topicId, conversationId })
  if (!container) {
    throw new ApiError(
      httpStatus.NOT_FOUND,
      conversationId ? `Conversation with id ${conversationId} not found` : `Topic with id ${topicId} not found`
    )
  }
  await artifactService.authorizeArtifactWrite(container, caller)

  const existing = await Artifact.findOne({
    ...(conversationId ? { conversation: conversationId } : { topic: topicId, scope: 'topic' }),
    __t: CONCEPT_GRAPH_ARTIFACT,
    isDeleted: { $ne: true }
  })
    .sort('createdAt')
    .exec()

  const callerId = caller._id!.toString()

  if (existing) {
    const claimed = await Artifact.findOneAndUpdate(
      { _id: existing._id, generationStatus: { $ne: 'pending' } },
      { $set: { generationStatus: 'pending' }, $unset: { generationError: '' } },
      { new: true }
    ).exec()
    if (!claimed) {
      // Already generating — hand back the in-flight artifact rather than starting a duplicate.
      return existing
    }
    await schedule.generateConceptGraph({ artifactId: claimed._id!.toString(), conversationId, topicId, callerId, reset })
    return claimed
  }

  const name = conversationId
    ? (await Conversation.findById(conversationId).select('name').lean().exec())?.name
    : (await Topic.findOne({ _id: topicId, isDeleted: { $ne: true } }).select('name').lean().exec())?.name

  const artifact = await Artifact.create({
    __t: CONCEPT_GRAPH_ARTIFACT,
    scope: container.scope,
    topic: container.topicId,
    ...(container.scope === 'conversation' && { conversation: container.conversationId }),
    title: `Concept map — ${name ?? (conversationId ? 'event' : 'series')}`,
    createdBy: caller?._id,
    generationStatus: 'pending'
  })

  await schedule.generateConceptGraph({ artifactId: artifact._id!.toString(), conversationId, topicId, callerId, reset })

  return artifact
}

const conceptGraphService = {
  generateConceptGraph,
  refineTopicGraph,
  enqueueGeneration,
  chunkSources,
  loadSources,
  GRAPH_SOURCE_CHANNELS
}
export default conceptGraphService
