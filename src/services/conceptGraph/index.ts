import httpStatus from 'http-status'
import { traceable } from 'langsmith/traceable'
import logger from '../../config/logger.js'
import ApiError from '../../utils/ApiError.js'
import { Conversation, Message, RealNameRegistry, User } from '../../models/index.js'
import Artifact from '../../models/artifact.model/artifact.js'
import { CONCEPT_GRAPH_ARTIFACT } from '../../models/artifact.model/conceptGraphArtifact.js'
import { getModelChat, coreLLMModel, coreLLMPlatform } from '../../agents/helpers/getModelChat.js'
import { getChatPromptResponse } from '../../agents/helpers/llmChain.js'
import artifactService from '../artifact.service.js'
import { EXTRACTION_PROMPT, EXTRACTION_SCHEMA } from './prompt.js'
import { assembleGraph, AssemblyReport, ExtractionResult, SourceRefMap } from './assemble.js'
import { screenForIdentities } from './nameScreen.js'
import { ConceptGraphPayload, IBaseUser } from '../../types/index.types.js'

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
  /* Verbatim message bodies, for the quote checker to compare against. */
  texts: string[]
  /* The same messages tagged [m1], [m2]..., which is what the model actually reads. */
  taggedLines: string[]
  /* Tag to message id, so a cited tag becomes real provenance. */
  sourceRefs: SourceRefMap
  knownIdentities: string[]
}

/*
 * Every name this conversation knows, for the attribution check.
 *
 * Three registers, because a participant can appear under any of them: the pseudonym they
 * posted under, a real name reserved in RealNameRegistry when the conversation runs with
 * real names on, and the presenters and moderators named on the conversation record.
 */
const collectKnownIdentities = async (conversation): Promise<string[]> => {
  const identities = new Set<string>()

  for (const profile of [...(conversation.presenters ?? []), ...(conversation.moderators ?? [])]) {
    if (profile?.name) identities.add(profile.name)
    if (profile?.alternateName) identities.add(profile.alternateName)
  }

  const reservations = await RealNameRegistry.find({ conversationId: conversation._id })
    .select('normalizedPseudonym')
    .lean()
    .exec()
  for (const reservation of reservations)
    if (reservation.normalizedPseudonym) identities.add(reservation.normalizedPseudonym)

  /* Pseudonyms of everyone who posted here. Read off the users rather than the messages so
     an inactive pseudonym still counts — a name is identifying whether or not it is the one
     currently displayed. */
  const posters = await Message.distinct('owner', { conversation: conversation._id }).exec()
  if (posters.length > 0) {
    const users = await User.find({ _id: { $in: posters } })
      .select('pseudonyms.pseudonym')
      .lean()
      .exec()
    for (const user of users) for (const p of user.pseudonyms ?? []) if (p?.pseudonym) identities.add(p.pseudonym)
  }

  return [...identities]
}

/** The messages the graph is built from, oldest first, plus the identities to screen for. */
const loadSources = async (conversation): Promise<GraphSources> => {
  const messages = await Message.find({
    conversation: conversation._id,
    channels: { $in: [...GRAPH_SOURCE_CHANNELS] },
    visible: { $ne: false }
  })
    .sort({ createdAt: 1 })
    .select('body fromAgent')
    .lean()
    .exec()

  /* Agent messages are excluded: an assistant's own summaries and prompts are not the
     room's thinking, and mapping them would feed the model's earlier output back in as if
     participants had said it. */
  const usable = messages.filter((m) => !m.fromAgent && typeof m.body === 'string' && m.body.trim().length > 0)

  const texts: string[] = []
  const taggedLines: string[] = []
  const sourceRefs: SourceRefMap = new Map()
  usable.forEach((message, index) => {
    const tag = `m${index + 1}`
    const body = (message.body as string).trim()
    texts.push(body)
    /* No speaker labels on these lines, deliberately. The model cannot reveal an identity
       it was never shown, which makes the Chatham House guarantee structural here rather
       than something the prompt has to talk it out of. */
    taggedLines.push(`[${tag}] ${body}`)
    sourceRefs.set(tag, message._id!.toString())
  })

  return { texts, taggedLines, sourceRefs, knownIdentities: await collectKnownIdentities(conversation) }
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

const extractFromChunk = async (llm, chunk: string, conversationId: string, index: number): Promise<ExtractionResult> => {
  /* Tagged the way the stop-time summary is, so numberCruncher attributes this spend to the
     conversation it maps and groups it with the rest of the post-event work. */
  const result = await traceable(
    async () =>
      getChatPromptResponse(llm, EXTRACTION_PROMPT, 'Event record:\n\n{chunk}', { chunk }, undefined, EXTRACTION_SCHEMA),
    { name: 'conceptGraphExtraction', metadata: { conversationId, costPhase: 'postEvent' as const, chunk: index } }
  )()
  return result as ExtractionResult
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
  const candidates: { text: string; kind: 'statement' | 'concept' | 'prompt'; id: string }[] = [
    ...payload.contributions
      .filter((c) => c.statement)
      .map((c) => ({ text: c.statement!, kind: 'statement' as const, id: c.id })),
    ...payload.concepts.map((c) => ({ text: c.label, kind: 'concept' as const, id: c.id })),
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
  const unsafePrompts = flaggedOf('prompt')

  const concepts = payload.concepts.filter((c) => !unsafeConcepts.has(c.id))
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
  const conversation = await Conversation.findById(conversationId).select('name presenters moderators topic').lean().exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }

  const { texts, taggedLines, sourceRefs, knownIdentities } = await loadSources({ ...conversation, _id: conversationId })
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0)
  if (totalChars < MIN_SOURCE_CHARS) {
    logger.info(`conceptGraph: conversation ${conversationId} has too little content to map (${totalChars} chars)`)
    return null
  }

  const llm = await getModelChat(coreLLMPlatform, coreLLMModel, { maxTokens: 4000 })
  const chunks = chunkSources(taggedLines)
  const results: ExtractionResult[] = []
  for (const [index, chunk] of chunks.entries()) {
    try {
      results.push(await extractFromChunk(llm, chunk, conversationId, index))
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

  const assembled = assembleGraph(results, { sourceTexts: texts, knownIdentities }, conversationId, sourceRefs)

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

  const note = `Generated from ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} of the event record`

  if (existing) {
    const version = await artifactService.appendVersion(existing._id!.toString(), { payload, note }, caller)
    return { artifact: existing, version, report }
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
  return { artifact, version, report }
}

const conceptGraphService = { generateConceptGraph, chunkSources, loadSources, GRAPH_SOURCE_CHANNELS }
export default conceptGraphService
