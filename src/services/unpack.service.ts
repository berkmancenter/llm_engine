import httpStatus from 'http-status'
import mongoose from 'mongoose'
import config from '../config/config.js'
import logger from '../config/logger.js'
import { Channel, Conversation, UnpackPassageExplanation, UnpackRequest } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import assertMembership from '../utils/assertMembership.js'
import authChannels from '../utils/authChannels.js'
import { findMessages } from '../utils/messageVisibility.js'
import { getBedrockChat } from '../agents/helpers/getModelChat.js'
import transcript from '../agents/helpers/transcript.js'
import {
  buildPassage,
  explainPassage,
  getPassageContext,
  isUnpackerEnabled,
  toPlainText,
  UNPACK_CONTEXT_AFTER_SECONDS,
  UNPACK_PASSAGE_MAX_CHARACTERS
} from '../agents/helpers/unpackPassage.js'
import { getConversationType } from '../conversations/index.js'
import schedule from '../jobs/schedule.js'
import messageService, { agentResponseToMessageData } from './message.service.js'
import {
  IUnpackPassageExplanation,
  IUnpackRequest,
  ReadyUnpackPassageExplanation,
  TRANSCRIPT_CHANNEL,
  UnpackDestination,
  UnpackExplanation,
  UnpackPassage,
  UnpackRange,
  UnpackTranscriptChunk
} from '../types/index.types.js'

// Higher than the "Catch me up" limit: someone reading along may pick several passages in a row
export const UNPACK_PREVIEWS_PER_MINUTE = 10
// Each whole-chunk explanation is an AI model call that no participant waits on or is rate limited for
export const UNPACK_WHOLE_CHUNKS_PER_SEND = 3
const UNPACK_WAIT_POLL_MS = 250
const UNPACK_WAIT_SLOW_POLL_MS = 1000
const UNPACK_WAIT_FAST_POLLING_MS = 1000
// About two and a half times a typical answer, with room for a visual's description, alt text, and caption
const UNPACK_MAX_OUTPUT_TOKENS = 1500
const UNPACK_CHUNK_BATCH = 100
const UNPACK_PENDING_CHECK_ATTEMPTS = 3
// The reply quotes no transcript: clearing the transcript removes cards, but can't find a plain text reply
const UNPACK_FAILED_REPLY = "Sorry, I couldn't unpack the passage you sent just now. Please send it again in a moment."

/** Waits, in milliseconds. An object so tests can shorten them. */
export const UNPACK_TIMING = {
  // The load balancer cuts a request off at 30 seconds, and its error has no reason the client can act on
  previewBudgetMs: 25 * 1000,
  // A row still generating after this long was most likely left behind by a server that stopped
  staleGenerationMs: 60 * 1000,
  // Late enough that any write running at Send time has finished or gone stale
  pendingCheckDelayMs: 90 * 1000
}

interface UnpackEvent {
  conversation
  assistant
  /** The sender's Private Chat, when the request already looked it up */
  senderPrivateChat?
}

const backgroundWork = new Set<Promise<unknown>>()

function unpackError(status: number, reason: string, message: string) {
  return new ApiError(status, message, { reason })
}

const unpackFailed = () =>
  unpackError(httpStatus.SERVICE_UNAVAILABLE, 'unpackFailed', "The assistant couldn't explain that just now. Try again.")

const transcriptGone = () =>
  unpackError(httpStatus.BAD_REQUEST, 'chunkNotInTranscript', 'The transcript this passage quotes was deleted.')

const selectionTooLong = () =>
  unpackError(httpStatus.BAD_REQUEST, 'selectionTooLong', `The passage is over ${UNPACK_PASSAGE_MAX_CHARACTERS} characters.`)

function track(work: Promise<unknown>) {
  const tracked = work.catch(() => undefined).finally(() => backgroundWork.delete(tracked))
  backgroundWork.add(tracked)
}

function runInBackground(work: Promise<unknown>, description: string) {
  track(work.catch((error) => logger.error(`unpack: ${description} failed`, error)))
}

/** Background explanations outlive the request that started them; this waits for every one still running. */
export async function settleBackgroundUnpacks() {
  while (backgroundWork.size > 0) await Promise.allSettled([...backgroundWork])
}

function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(unpackFailed()), Math.max(0, deadline - Date.now()))
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

function isReady(explanation: IUnpackPassageExplanation | null): explanation is ReadyUnpackPassageExplanation {
  return (
    explanation?.status === 'ready' &&
    explanation.whatTheyreSaying != null &&
    explanation.whyItMatters != null &&
    explanation.headline != null &&
    explanation.range != null &&
    explanation.passage?.start != null &&
    explanation.passage?.end != null
  )
}

function isStale(explanation: IUnpackPassageExplanation) {
  const staleBefore = Date.now() - UNPACK_TIMING.staleGenerationMs
  return !explanation.generatingSince || explanation.generatingSince.getTime() < staleBefore
}

function findAssistant(conversation) {
  const conversationType = conversation.conversationType ? getConversationType(conversation.conversationType) : undefined
  const respondingAgent = conversationType?.features?.find(({ name }) => name === 'unpacker')?.respondingAgent
  if (!respondingAgent) return undefined
  return conversation.agents.find((agent) => agent.agentType === respondingAgent)
}

function findPrivateChat(conversation, userId: mongoose.Types.ObjectId, assistant) {
  return Channel.findOne({
    _id: { $in: conversation.channels },
    direct: true,
    participants: { $all: [userId, assistant._id] }
  })
}

async function loadEvent(conversationId: string, user, transcriptPasscode?: string): Promise<UnpackEvent> {
  const conversation = await Conversation.findById(conversationId).populate('agents')
  if (!conversation) throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  await assertMembership(user, conversation)
  if (!isUnpackerEnabled(conversation)) {
    throw unpackError(httpStatus.FORBIDDEN, 'unpackerOff', 'The Unpacker is not turned on for this event.')
  }
  await authChannels([{ name: TRANSCRIPT_CHANNEL, passcode: transcriptPasscode }], conversation._id, user)
  const assistant = findAssistant(conversation)
  if (!assistant) throw unpackError(httpStatus.CONFLICT, 'noAssistant', 'This event has no assistant to explain the talk.')
  return { conversation, assistant }
}

async function loadEventForPosting(conversationId: mongoose.Types.ObjectId): Promise<UnpackEvent | null> {
  const conversation = await Conversation.findById(conversationId).populate('agents')
  const assistant = conversation && findAssistant(conversation)
  if (!assistant) {
    logger.warn(`unpack: ${conversationId} has no assistant, so no cards were posted`)
    return null
  }
  return { conversation, assistant }
}

/**
 * Loads the transcript from one end of a selection to the other, in batches. It stops as soon as the chunks
 * between the ends hold more text than a passage can, so a huge selection is refused without loading all of it.
 */
async function loadSelectedChunks(conversationId: mongoose.Types.ObjectId, ends): Promise<UnpackTranscriptChunk[]> {
  const times = ends.map(({ createdAt }) => createdAt.getTime())
  const endIds = new Set(ends.map(({ _id }) => _id.toString()))
  const chunks: UnpackTranscriptChunk[] = []
  let charactersBetween = 0
  for (;;) {
    const previous = chunks[chunks.length - 1]
    const batch = await findMessages(
      conversationId,
      'model',
      {
        channels: TRANSCRIPT_CHANNEL,
        createdAt: { $gte: new Date(Math.min(...times)), $lte: new Date(Math.max(...times)) },
        ...(previous && {
          $or: [{ createdAt: { $gt: previous.createdAt } }, { createdAt: previous.createdAt, _id: { $gt: previous._id } }]
        })
      },
      { select: 'body createdAt', sort: { createdAt: 1, _id: 1 }, lean: true, limit: UNPACK_CHUNK_BATCH }
    )
    chunks.push(...batch)
    for (const chunk of batch) {
      if (!endIds.has(chunk._id.toString())) charactersBetween += String(chunk.body ?? '').trim().length
    }
    if (charactersBetween > UNPACK_PASSAGE_MAX_CHARACTERS) throw selectionTooLong()
    if (batch.length < UNPACK_CHUNK_BATCH) return chunks
  }
}

async function resolvePassage(conversationId: mongoose.Types.ObjectId, selection: UnpackRange): Promise<UnpackPassage> {
  const ends = await findMessages(
    conversationId,
    'model',
    { _id: { $in: [selection.startMessageId, selection.endMessageId] }, channels: TRANSCRIPT_CHANNEL },
    { select: 'createdAt', lean: true }
  )
  if (ends.length === 0) return buildPassage([], selection)
  return buildPassage(await loadSelectedChunks(conversationId, ends), selection)
}

async function chunksStillSaved(conversationId: mongoose.Types.ObjectId, chunkIds: mongoose.Types.ObjectId[]) {
  const saved = await findMessages(
    conversationId,
    'model',
    { _id: { $in: chunkIds }, channels: TRANSCRIPT_CHANNEL },
    { select: '_id', lean: true }
  )
  return saved.length === chunkIds.length
}

async function cardSaved(conversationId: mongoose.Types.ObjectId, messageId: mongoose.Types.ObjectId) {
  return (await findMessages(conversationId, 'admin', { _id: messageId }, { select: '_id', lean: true })).length > 0
}

const isDuplicateKey = (error) => error?.code === 11000

/**
 * Finds the shared explanation for a passage, or claims the right to write it. Only one request can claim a
 * passage, through the unique passage key, so two people asking at once make one AI model call.
 */
async function claimExplanation(conversationId: mongoose.Types.ObjectId, passage: UnpackPassage) {
  const existing = await UnpackPassageExplanation.findOne({ passageKey: passage.key })
  if (!existing) {
    const first = passage.pieces[0].chunk
    const last = passage.pieces[passage.pieces.length - 1].chunk
    let claimed: IUnpackPassageExplanation
    try {
      claimed = await UnpackPassageExplanation.create({
        conversation: conversationId,
        passageKey: passage.key,
        range: passage.range,
        chunkIds: passage.pieces.map(({ chunk }) => chunk._id),
        quote: passage.quote,
        passage: { start: first.createdAt, end: last.createdAt },
        status: 'generating',
        generatingSince: new Date()
      })
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      return claimExplanation(conversationId, passage)
    }
    if (!(await chunksStillSaved(conversationId, claimed.chunkIds))) {
      await UnpackPassageExplanation.deleteOne({ _id: claimed._id })
      throw transcriptGone()
    }
    return { explanation: claimed, mustWrite: true }
  }
  if (existing.status === 'generating' && isStale(existing)) {
    const takenOver = await UnpackPassageExplanation.findOneAndUpdate(
      { _id: existing._id, status: 'generating', generatingSince: existing.generatingSince ?? null },
      { generatingSince: new Date() },
      { new: true }
    )
    if (takenOver) return { explanation: takenOver, mustWrite: true }
  }
  return { explanation: existing, mustWrite: false }
}

async function findOrCreateAsk(conversationId: mongoose.Types.ObjectId, user, passage: UnpackPassage) {
  const existing = await UnpackRequest.findOne({ user: user._id, passageKey: passage.key })
  if (existing) return existing
  let ask
  try {
    ask = await UnpackRequest.create({
      conversation: conversationId,
      user: user._id,
      mode: 'passage',
      status: 'previewed',
      passageKey: passage.key,
      range: passage.range,
      chunkIds: passage.pieces.map(({ chunk }) => chunk._id),
      quote: passage.quote
    })
  } catch (error) {
    if (!isDuplicateKey(error)) throw error
    const other = await UnpackRequest.findOne({ user: user._id, passageKey: passage.key })
    // The other request's ask is gone if the transcript was cleared at the same moment
    if (!other) throw unpackFailed()
    return other
  }
  if (!(await chunksStillSaved(conversationId, ask.chunkIds))) {
    await UnpackRequest.deleteOne({ _id: ask._id })
    throw transcriptGone()
  }
  return ask
}

/**
 * Counts recent passage asks up to this one, refused ones included. Refused asks are kept and marked, so a double
 * click that finds one is refused too. Asks saved at the same moment can get IDs out of order and both fit.
 * @returns the ask, set back to `previewed` once a refused one fits under the limit
 */
async function enforcePreviewLimit(ask) {
  if (ask.status === 'sent') return ask
  const recent = await UnpackRequest.countDocuments({
    conversation: ask.conversation,
    user: ask.user,
    passageKey: { $type: 'string' },
    createdAt: { $gte: new Date(Date.now() - 60 * 1000) },
    _id: { $lte: ask._id }
  })
  if (recent > UNPACK_PREVIEWS_PER_MINUTE) {
    await UnpackRequest.updateOne({ _id: ask._id, status: 'previewed' }, { status: 'refused' })
    throw unpackError(
      httpStatus.TOO_MANY_REQUESTS,
      'rateLimited',
      'Too many passages in the last minute. Try again shortly.'
    )
  }
  if (ask.status !== 'refused') return ask
  return (
    (await UnpackRequest.findOneAndUpdate({ _id: ask._id, status: 'refused' }, { status: 'previewed' }, { new: true })) ??
    UnpackRequest.findById(ask._id)
  )
}

function sharedFields(explanation: ReadyUnpackPassageExplanation) {
  const { range } = explanation
  return {
    range: {
      startMessageId: range.startMessageId.toString(),
      startOffset: range.startOffset,
      endMessageId: range.endMessageId.toString(),
      endOffset: range.endOffset
    },
    chunkIds: explanation.chunkIds.map((id) => id.toString()),
    passage: { start: explanation.passage.start.toISOString(), end: explanation.passage.end.toISOString() },
    quote: explanation.quote,
    whatTheyreSaying: explanation.whatTheyreSaying,
    whyItMatters: explanation.whyItMatters,
    terms: explanation.terms ?? [],
    headline: explanation.headline
  }
}

function toCard(explanation: ReadyUnpackPassageExplanation, destination: UnpackDestination): UnpackExplanation {
  const fields = sharedFields(explanation)
  return { type: 'unpack_explanation', mode: 'passage', destination, ...fields, text: toPlainText(fields) }
}

function toPreview(explanation: ReadyUnpackPassageExplanation) {
  return { ...sharedFields(explanation), visual: explanation.visual ?? null }
}

async function postToPrivateChat(event: UnpackEvent, userId: mongoose.Types.ObjectId, response) {
  const known = event.senderPrivateChat
  const channel = known?.participants.some((participant) => participant.equals(userId))
    ? known
    : await findPrivateChat(event.conversation, userId, event.assistant)
  if (!channel) {
    throw unpackError(httpStatus.CONFLICT, 'noPrivateChat', 'You have no Private Chat with the assistant in this event.')
  }
  await messageService.newMessageHandler(
    agentResponseToMessageData({ visible: true, ...response, channels: [channel] }, event.assistant),
    event.assistant
  )
}

type Poster = (event: UnpackEvent, userId: mongoose.Types.ObjectId, response) => Promise<void>
const POSTERS: Partial<Record<UnpackDestination, Poster>> = { privateChat: postToPrivateChat }

async function postToDestination(event: UnpackEvent, ask: IUnpackRequest, response) {
  const post = ask.destination && POSTERS[ask.destination]
  if (!post) throw new Error(`unpack: no way to post to ${ask.destination} yet`)
  await post(event, ask.user, response)
}

/** Returns no explanation when another request took the claim over while the AI model was writing. */
async function writeExplanation(
  conversation,
  claimed: IUnpackPassageExplanation,
  passage: UnpackPassage,
  askedAt: Date
): Promise<{ ready: ReadyUnpackPassageExplanation | null; modelMs: number }> {
  const claim = { _id: claimed._id, status: 'generating', generatingSince: claimed.generatingSince ?? null }
  let ready: IUnpackPassageExplanation | null
  let modelMs = 0
  try {
    const { before, after, until } = await getPassageContext(conversation._id, passage, askedAt)
    const llm = await getBedrockChat(config.unpackLLMModel, { maxTokens: UNPACK_MAX_OUTPUT_TOKENS })
    const modelStartedAt = Date.now()
    const sections = await explainPassage(llm, { topic: conversation.name, passage, before, after })
    modelMs = Date.now() - modelStartedAt
    ready = await UnpackPassageExplanation.findOneAndUpdate(
      claim,
      { ...sections, status: 'ready', contextUntil: until, $unset: { generatingSince: 1 } },
      { new: true }
    )
  } catch (error) {
    logger.error(`unpack: could not explain passage ${passage.key} in ${conversation._id}`, error)
    // eslint-disable-next-line no-use-before-define
    await abandonClaim(claim, passage.key)
    throw unpackFailed()
  }
  if (!isReady(ready)) return { ready: null, modelMs }
  // eslint-disable-next-line no-use-before-define
  runInBackground(postWaitingAsks(ready), `posting cards for ${passage.key}`)
  return { ready, modelMs }
}

async function startWholeChunkExplanations(ask) {
  // Counts only earlier passage asks, so when several waiting cards post together the first one still starts this
  const sentBefore = await UnpackRequest.distinct('chunkIds', {
    conversation: ask.conversation,
    chunkIds: { $in: ask.chunkIds },
    mode: 'passage',
    status: 'sent',
    _id: { $lt: ask._id }
  })
  const sentIds = new Set(sentBefore.map((id) => id.toString()))
  const firstSends = ask.chunkIds.filter((id) => !sentIds.has(id.toString())).slice(0, UNPACK_WHOLE_CHUNKS_PER_SEND)
  if (firstSends.length === 0) return
  const conversation = await Conversation.findById(ask.conversation).select('name')
  if (!conversation) return
  const chunks = await findMessages(
    conversation._id,
    'model',
    { _id: { $in: firstSends }, channels: TRANSCRIPT_CHANNEL },
    { select: 'body createdAt', lean: true }
  )
  for (const chunk of chunks) {
    const id = chunk._id.toString()
    let passage: UnpackPassage
    try {
      passage = buildPassage([chunk], { startMessageId: id, startOffset: 0, endMessageId: id, endOffset: chunk.body.length })
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === httpStatus.BAD_REQUEST) continue
      throw error
    }
    const claim = await claimExplanation(conversation._id, passage)
    if (claim.mustWrite) {
      runInBackground(
        writeExplanation(conversation, claim.explanation, passage, new Date()),
        `whole-chunk explanation of ${id}`
      )
    }
  }
}

/**
 * Posts one ask's card, unless another request already has: claiming the ask first makes the post happen once.
 * When posting fails before the card is saved, the claim is undone and the error is rethrown. The destination
 * stays, so the participant can send again and a scheduled pending check can retry.
 */
async function postAsk(event: UnpackEvent, askId: mongoose.Types.ObjectId, explanation: ReadyUnpackPassageExplanation) {
  const answerId = new mongoose.Types.ObjectId()
  const ask = await UnpackRequest.findOneAndUpdate(
    { _id: askId, status: 'previewed', destination: { $exists: true } },
    { status: 'sent', answerMessage: answerId, explanation: explanation._id },
    { new: true }
  )
  if (!ask) return
  try {
    await postToDestination(event, ask, {
      message: toCard(explanation, ask.destination!),
      messageType: 'json',
      messageId: answerId
    })
  } catch (error) {
    if (!(await cardSaved(ask.conversation, answerId))) {
      await UnpackRequest.updateOne(
        { _id: askId, answerMessage: answerId },
        { status: 'previewed', $unset: { answerMessage: 1, explanation: 1 } }
      )
      throw error
    }
    logger.error(`unpack: card ${answerId} for ask ${askId} was saved, but posting it then failed`, error)
  }
  // Clearing the transcript while the card was posting deletes the rows, but not a card saved after it ran
  if (!(await chunksStillSaved(ask.conversation, ask.chunkIds))) {
    await transcript.deleteUnpackCards(ask.conversation, { _id: answerId })
    await UnpackRequest.deleteOne({ _id: askId })
    throw transcriptGone()
  }
  runInBackground(startWholeChunkExplanations(ask), `whole-chunk explanations for ask ${askId}`)
}

async function postWaitingAsks(explanation: ReadyUnpackPassageExplanation) {
  const waiting = await UnpackRequest.find({
    passageKey: explanation.passageKey,
    status: 'previewed',
    destination: { $exists: true }
  }).select('_id')
  if (waiting.length === 0) return
  const event = await loadEventForPosting(explanation.conversation)
  if (!event) return
  for (const { _id } of waiting) {
    try {
      await postAsk(event, _id, explanation)
    } catch (error) {
      // The ask keeps its destination, so the pending check scheduled at Send time tries again
      logger.error(`unpack: could not post ask ${_id} in ${explanation.conversation}`, error)
    }
  }
}

async function failWaitingAsks(passageKey: string) {
  const waiting = await UnpackRequest.find({ passageKey, status: 'previewed', destination: { $exists: true } })
  if (waiting.length === 0) return
  const event = await loadEventForPosting(waiting[0].conversation)
  for (const { _id } of waiting) {
    try {
      const ask = await UnpackRequest.findOneAndUpdate(
        { _id, status: 'previewed', destination: { $exists: true } },
        { $unset: { destination: 1 } }
      )
      if (ask && event) {
        await postToDestination(event, ask, { message: UNPACK_FAILED_REPLY, messageType: 'text' })
      }
    } catch (error) {
      logger.error(`unpack: could not tell ask ${_id} that its explanation failed`, error)
    }
  }
}

/** Drops a failed claim so the next request tries again, and tells everyone waiting on it. Never throws. */
async function abandonClaim(claim, passageKey: string) {
  try {
    const { deletedCount } = await UnpackPassageExplanation.deleteOne(claim)
    // Another request took the passage over, and it will post or fail the waiting asks itself
    if (deletedCount === 0) return
    await failWaitingAsks(passageKey)
  } catch (error) {
    logger.error(`unpack: could not clean up after failing to explain ${passageKey}`, error)
  }
}

async function waitForExplanation(passageKey: string, deadline: number): Promise<ReadyUnpackPassageExplanation> {
  const startedAt = Date.now()
  while (Date.now() < deadline) {
    const pollMs = Date.now() - startedAt < UNPACK_WAIT_FAST_POLLING_MS ? UNPACK_WAIT_POLL_MS : UNPACK_WAIT_SLOW_POLL_MS
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    const explanation = await UnpackPassageExplanation.findOne({ passageKey })
    if (!explanation) throw unpackFailed()
    if (isReady(explanation)) return explanation
  }
  throw unpackFailed()
}

/**
 * An explanation written moments after the passage was spoken saw little of what followed, and "why it matters"
 * often depends on it. Once that transcript exists, one request rewrites the row; until then everyone gets the
 * earlier version. A failed rewrite gives the claim back, so a later request tries again.
 */
async function rewriteWithFullerContext(conversation, explanation: ReadyUnpackPassageExplanation, passage: UnpackPassage) {
  const fullUntil = new Date(explanation.passage.end.getTime() + UNPACK_CONTEXT_AFTER_SECONDS * 1000)
  if (!explanation.contextUntil || explanation.contextUntil >= fullUntil || Date.now() < fullUntil.getTime()) return
  const claimed = await UnpackPassageExplanation.findOneAndUpdate(
    { _id: explanation._id, status: 'ready', contextUntil: explanation.contextUntil },
    { contextUntil: fullUntil }
  )
  if (!claimed) return
  try {
    const { before, after, until } = await getPassageContext(conversation._id, passage, new Date())
    const llm = await getBedrockChat(config.unpackLLMModel, { maxTokens: UNPACK_MAX_OUTPUT_TOKENS })
    const sections = await explainPassage(llm, { topic: conversation.name, passage, before, after })
    await UnpackPassageExplanation.updateOne({ _id: explanation._id, status: 'ready' }, { ...sections, contextUntil: until })
  } catch (error) {
    await UnpackPassageExplanation.updateOne(
      { _id: explanation._id, contextUntil: fullUntil },
      { contextUntil: explanation.contextUntil }
    )
    throw error
  }
}

/**
 * Explains a passage the participant selected, reusing a saved explanation when there is one, and records their
 * ask. A later send posts the explanation as it is then, which a background rewrite may have improved since.
 */
const previewPassage = async (conversationId: string, user, selection: UnpackRange, transcriptPasscode?: string) => {
  const startedAt = Date.now()
  const deadline = startedAt + UNPACK_TIMING.previewBudgetMs
  const { conversation } = await loadEvent(conversationId, user, transcriptPasscode)
  const passage = await resolvePassage(conversation._id, selection)
  const ask = await enforcePreviewLimit(await findOrCreateAsk(conversation._id, user, passage))
  const claim = await claimExplanation(conversation._id, passage)

  let explanation: ReadyUnpackPassageExplanation | null = isReady(claim.explanation) ? claim.explanation : null
  let cache = 'hit'
  let modelMs = 0
  if (claim.mustWrite) {
    // Kept running if this preview gives up first, so the explanation is saved for the retry
    const writing = writeExplanation(conversation, claim.explanation, passage, new Date(startedAt))
    track(writing)
    ;({ ready: explanation, modelMs } = await beforeDeadline(writing, deadline))
    cache = 'miss'
  }
  if (!explanation) {
    explanation = await waitForExplanation(passage.key, deadline)
    if (cache === 'hit') cache = 'shared'
  } else if (cache === 'hit') {
    runInBackground(rewriteWithFullerContext(conversation, explanation, passage), `fuller explanation of ${passage.key}`)
  }

  logger.info(
    `unpack: preview ${conversation._id} cache=${cache} model=${config.unpackLLMModel} totalMs=${
      Date.now() - startedAt
    } modelMs=${modelMs}`
  )
  return { askId: ask._id.toString(), explanation: toPreview(explanation) }
}

/**
 * Sends a passage's explanation to the participant's chosen destination. Works before or without a preview: the
 * choice is stored on the ask and the card posts as soon as the explanation is ready.
 */
const sendPassage = async (
  conversationId: string,
  user,
  selection: UnpackRange,
  destination: UnpackDestination,
  transcriptPasscode?: string
) => {
  const loaded = await loadEvent(conversationId, user, transcriptPasscode)
  const senderPrivateChat = await findPrivateChat(loaded.conversation, user._id, loaded.assistant)
  if (!senderPrivateChat) {
    throw unpackError(httpStatus.CONFLICT, 'noPrivateChat', 'You have no Private Chat with the assistant in this event yet.')
  }
  const event = { ...loaded, senderPrivateChat }
  const passage = await resolvePassage(event.conversation._id, selection)
  const ask = await enforcePreviewLimit(await findOrCreateAsk(event.conversation._id, user, passage))

  let storedDestination = false
  if (ask.status === 'previewed') {
    const stored = await UnpackRequest.updateOne({ _id: ask._id, status: 'previewed' }, { destination })
    storedDestination = stored.modifiedCount === 1
    // Claimed after the destination is stored, so any write that finishes or fails from now on includes this ask
    const claim = await claimExplanation(event.conversation._id, passage)
    if (claim.mustWrite) {
      runInBackground(
        writeExplanation(event.conversation, claim.explanation, passage, new Date()),
        `explanation of ${passage.key}`
      )
    } else if (isReady(claim.explanation)) {
      await postAsk(event, ask._id, claim.explanation)
    }
  }

  const latest = await UnpackRequest.findById(ask._id)
  if (latest?.status === 'sent') {
    return { askId: latest._id.toString(), status: 'sent', messageId: latest.answerMessage?.toString() }
  }
  // An earlier send that stored the same destination already scheduled the check
  if (storedDestination) {
    await schedule.unpackPendingAsk(new Date(Date.now() + UNPACK_TIMING.pendingCheckDelayMs), {
      askId: ask._id.toString(),
      attempt: 1
    })
  }
  return { askId: ask._id.toString(), status: 'pending' }
}

async function giveUpOnAsk(event: UnpackEvent, askId: string) {
  const ask = await UnpackRequest.findOneAndUpdate(
    { _id: askId, status: 'previewed', destination: { $exists: true } },
    { $unset: { destination: 1 } }
  )
  if (ask) await postToDestination(event, ask, { message: UNPACK_FAILED_REPLY, messageType: 'text' })
}

/** Writes and posts the card for a passage the participant sent, returning false when it should be checked again. */
async function tryToFinishAsk(event: UnpackEvent, ask, passage: UnpackPassage): Promise<boolean> {
  const claim = await claimExplanation(event.conversation._id, passage)
  let explanation = isReady(claim.explanation) ? claim.explanation : null
  if (claim.mustWrite) {
    try {
      ;({ ready: explanation } = await writeExplanation(event.conversation, claim.explanation, passage, new Date()))
    } catch (error) {
      // A failed write already told the participant and cleared their send
      if (error instanceof ApiError) return true
      throw error
    }
  }
  if (!explanation) return false
  await postAsk(event, ask._id, explanation)
  return true
}

/**
 * Recovers a Send left pending because the server writing its explanation stopped before posting the card, or
 * because posting it failed. Checks again later until the attempts run out, then tells the participant.
 */
const finishPendingAsk = async (askId: string, attempt: number) => {
  const ask = await UnpackRequest.findById(askId)
  if (!ask || ask.status !== 'previewed' || !ask.destination || !ask.range) return
  const event = await loadEventForPosting(ask.conversation)
  if (!event) return
  let passage: UnpackPassage
  try {
    passage = await resolvePassage(event.conversation._id, {
      startMessageId: ask.range.startMessageId.toString(),
      startOffset: ask.range.startOffset,
      endMessageId: ask.range.endMessageId.toString(),
      endOffset: ask.range.endOffset
    })
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    await giveUpOnAsk(event, askId)
    return
  }

  try {
    if (await tryToFinishAsk(event, ask, passage)) return
  } catch (error) {
    logger.error(`unpack: pending check ${attempt} for ask ${askId} failed`, error)
  }
  if (attempt < UNPACK_PENDING_CHECK_ATTEMPTS) {
    await schedule.unpackPendingAsk(new Date(Date.now() + UNPACK_TIMING.pendingCheckDelayMs), {
      askId,
      attempt: attempt + 1
    })
    return
  }
  logger.warn(`unpack: ask ${askId} was still pending after ${attempt} checks, so it was given up`)
  try {
    await giveUpOnAsk(event, askId)
  } catch (error) {
    logger.error(`unpack: could not tell ask ${askId} that it was given up`, error)
  }
}

export default { previewPassage, sendPassage, finishPendingAsk }
