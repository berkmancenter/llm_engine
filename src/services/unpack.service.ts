import { createHash } from 'node:crypto'
import { MemoryStore, type Options } from 'express-rate-limit'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import config from '../config/config.js'
import logger from '../config/logger.js'
import { Channel, Conversation, Message, UnpackGroupPost, UnpackPassageExplanation, UnpackRequest } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import assertMembership from '../utils/assertMembership.js'
import authChannels, { assertChannelPasscode } from '../utils/authChannels.js'
import { findMessages, loadHideContext } from '../utils/messageVisibility.js'
import sleep from '../utils/sleep.js'
import { getBedrockChat, resolveBedrockModel } from '../agents/helpers/getModelChat.js'
import transcript from '../agents/helpers/transcript.js'
import {
  buildPassage,
  chunksStillSaved,
  explainPassage,
  getPassageContext,
  isUnpackerEnabled,
  selectionTooLong,
  toPlainText,
  toSharedChatText,
  TRANSCRIPT_TEXT_CHUNKS,
  unpackError,
  UNPACK_CONTEXT_AFTER_SECONDS,
  UNPACK_PASSAGE_MAX_CHARACTERS
} from '../agents/helpers/unpackPassage.js'
import { getConversationType } from '../conversations/index.js'
import { CHAT_CHANNEL } from '../conversations/eventAssistant.js'
import isPreEventWindowOpen from './conversation.service/preEventWindow.js'
import schedule from '../jobs/schedule.js'
import messageService, { agentResponseToMessageData } from './message.service.js'
import { resolveDisplayName } from './user.service.js'
import {
  IUnpackPassageExplanation,
  ReadyUnpackPassageExplanation,
  UnpackDestination,
  UnpackEvent,
  UnpackExplanation,
  UnpackPassage,
  UnpackRange,
  UnpackTranscriptChunk,
  TRANSCRIPT_CHANNEL
} from '../types/index.types.js'

// Higher than the "Catch me up" limit: someone reading along may pick several passages in a row
export const UNPACK_MODEL_CALLS_PER_MINUTE = 10
const modelCallCounts = new MemoryStore()
modelCallCounts.init({ windowMs: 60 * 1000 } as Options)
// Resolved here so a model that doesn't run on Bedrock stops the server at startup, not every preview
const UNPACK_MODEL = resolveBedrockModel(config.unpackLLMModel)
// One participant can put a post in front of the whole room alone, so Group Chat gets a limit of its own
export const UNPACK_GROUP_CHAT_POST_WINDOW_MS = 2 * 60 * 1000 // 2 min
// When each participant started their last Group Chat post that went through, so the window runs from that post
const lastGroupChatPosts = new Map<string, number>()
// Posts block a whole transcript chunk, which can hold other sentences than the one this person picked
const UNPACK_ALREADY_POSTED_TEXT = 'A post about this part of the talk is already in Group Chat.'
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
  pendingCheckDelayMs: 90 * 1000,
  // A Group Chat post still `posting` after this long was most likely left behind by a server that stopped
  staleGroupPostMs: 60 * 1000,
  // How long a share waits for another post of the same passage to finish before asking to try again
  groupPostWaitMs: 10 * 1000
}

const backgroundWork = new Set<Promise<unknown>>()

const unpackFailed = () =>
  unpackError(httpStatus.SERVICE_UNAVAILABLE, 'unpackFailed', "The assistant couldn't explain that just now. Try again.")

const cardNotFound = () =>
  unpackError(httpStatus.NOT_FOUND, 'cardNotFound', 'That explanation is not one of your Private Chat cards in this event.')

// Worded so a participant can't tell a moderator hid the post
const sharingDisabled = () =>
  unpackError(httpStatus.CONFLICT, 'sharingDisabled', 'Sharing options are not enabled for this post.')

const transcriptGone = () =>
  unpackError(httpStatus.BAD_REQUEST, 'chunkNotInTranscript', 'The transcript this passage quotes was deleted.')

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
  await authChannels([{ name: TRANSCRIPT_CHANNEL, passcode: transcriptPasscode }], conversation, user)
  const assistant = findAssistant(conversation)
  if (!assistant) throw unpackError(httpStatus.CONFLICT, 'noAssistant', 'This event has no assistant to explain the talk.')
  return { conversation, assistant }
}

async function findGroupChat(conversation, chatPasscode?: string) {
  const channel = await Channel.findOne({ _id: { $in: conversation.channels }, name: CHAT_CHANNEL })
  if (!channel) throw unpackError(httpStatus.CONFLICT, 'noGroupChat', 'This event has no Group Chat.')
  assertChannelPasscode(channel, chatPasscode)
  return channel
}

async function loadEventToPostIn(conversationId: string, user, transcriptPasscode?: string): Promise<UnpackEvent> {
  const loaded = await loadEvent(conversationId, user, transcriptPasscode)
  // Checked here because the post itself would refuse with a 400 a client can't tell apart from a bad request
  if (loaded.conversation.locked) {
    throw unpackError(httpStatus.CONFLICT, 'eventLocked', 'This event is locked, so nothing new can be posted in it.')
  }
  const senderPrivateChat = await findPrivateChat(loaded.conversation, user._id, loaded.assistant)
  if (!senderPrivateChat) {
    throw unpackError(httpStatus.CONFLICT, 'noPrivateChat', 'You have no Private Chat with the assistant in this event yet.')
  }
  return { ...loaded, senderPrivateChat }
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
        ...TRANSCRIPT_TEXT_CHUNKS,
        createdAt: { $gte: new Date(Math.min(...times)), $lte: new Date(Math.max(...times)) },
        ...(previous && {
          $or: [{ createdAt: { $gt: previous.createdAt } }, { createdAt: previous.createdAt, _id: { $gt: previous._id } }]
        })
      },
      { select: 'body createdAt', sort: { createdAt: 1, _id: 1 }, lean: true, limit: UNPACK_CHUNK_BATCH }
    )
    chunks.push(...batch)
    for (const chunk of batch) {
      if (!endIds.has(chunk._id.toString())) charactersBetween += chunk.body.trim().length
    }
    if (charactersBetween > UNPACK_PASSAGE_MAX_CHARACTERS) throw selectionTooLong()
    if (batch.length < UNPACK_CHUNK_BATCH) return chunks
  }
}

async function resolvePassage(conversationId: mongoose.Types.ObjectId, selection: UnpackRange): Promise<UnpackPassage> {
  const ends = await findMessages(
    conversationId,
    'model',
    { _id: { $in: [selection.startMessageId, selection.endMessageId] }, ...TRANSCRIPT_TEXT_CHUNKS },
    { select: 'createdAt', lean: true }
  )
  if (ends.length === 0) return buildPassage([], selection)
  return buildPassage(await loadSelectedChunks(conversationId, ends), selection)
}

async function cardSaved(conversationId: mongoose.Types.ObjectId, messageId: mongoose.Types.ObjectId) {
  return (await findMessages(conversationId, 'admin', { _id: messageId }, { select: '_id', lean: true })).length > 0
}

const isDuplicateKey = (error) => error?.code === 11000

/** The same parts always give the same ID, so a second request saving the same message fails on the unique `_id`. */
function stableMessageId(...parts: (string | mongoose.Types.ObjectId)[]) {
  const hash = createHash('sha256').update(parts.map(String).join(':')).digest('hex')
  return new mongoose.Types.ObjectId(hash.slice(0, 24))
}

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

async function needsModelCall(passageKey: string) {
  const existing = await UnpackPassageExplanation.findOne({ passageKey }).select('status generatingSince').lean()
  return !existing || (existing.status === 'generating' && isStale(existing))
}

/**
 * Counts a model call this participant is about to cause, and refuses it once they are over the limit. The count
 * lives in memory, like the other rate limits, because a database count can miss a call another request is still
 * saving and let a burst through. A restart clears it.
 */
async function enforceModelCallLimit(ask) {
  const { totalHits } = await modelCallCounts.increment(`${ask.conversation}:${ask.user}`)
  if (totalHits <= UNPACK_MODEL_CALLS_PER_MINUTE) return
  throw unpackError(
    httpStatus.TOO_MANY_REQUESTS,
    'rateLimited',
    'Too many new explanations in the last minute. Try again shortly.'
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

/**
 * Returns no explanation when another writer saved first. That can be one that took the claim over after this
 * call ran past the stale limit; whichever finishes first wins, so a slow answer isn't thrown away.
 */
async function writeExplanation(
  conversation,
  claimed: IUnpackPassageExplanation,
  passage: UnpackPassage,
  askedAt: Date
): Promise<{ ready: ReadyUnpackPassageExplanation | null; modelMs: number }> {
  const claim = { _id: claimed._id, status: 'generating', generatingSince: claimed.generatingSince ?? null }
  const stillGenerating = { _id: claimed._id, status: 'generating' }
  let ready: IUnpackPassageExplanation | null
  let modelMs = 0
  try {
    const { before, after, until } = await getPassageContext(conversation._id, passage, askedAt)
    const llm = await getBedrockChat(UNPACK_MODEL, { maxTokens: UNPACK_MAX_OUTPUT_TOKENS })
    const modelStartedAt = Date.now()
    const sections = await explainPassage(llm, { topic: conversation.name, passage, before, after })
    modelMs = Date.now() - modelStartedAt
    ready = await UnpackPassageExplanation.findOneAndUpdate(
      stillGenerating,
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

/**
 * Posts one ask's card, unless another request already has: claiming the ask first makes the post happen once.
 * When posting fails before the card is saved, the claim is undone and the error is rethrown. The destination
 * stays, so the participant can send again and a scheduled pending check can retry.
 */
async function postAsk(event: UnpackEvent, askId: mongoose.Types.ObjectId, explanation: ReadyUnpackPassageExplanation) {
  const answerId = new mongoose.Types.ObjectId()
  const ask = await UnpackRequest.findOneAndUpdate(
    { _id: askId, status: 'previewed', destinations: 'privateChat' },
    { status: 'sent', answerMessage: answerId, explanation: explanation._id },
    { new: true }
  )
  if (!ask) return
  const card = toCard(explanation, 'privateChat')
  // eslint-disable-next-line no-use-before-define
  if (await isSharingDisabled(ask.conversation, card)) card.sharingDisabled = true
  try {
    await postToPrivateChat(event, ask.user, {
      message: card,
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
}

async function postWaitingAsks(explanation: ReadyUnpackPassageExplanation) {
  const waiting = await UnpackRequest.find({
    passageKey: explanation.passageKey,
    status: 'previewed',
    destinations: 'privateChat'
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
  const waiting = await UnpackRequest.find({ passageKey, status: 'previewed', destinations: 'privateChat' })
  if (waiting.length === 0) return
  const event = await loadEventForPosting(waiting[0].conversation)
  for (const { _id } of waiting) {
    try {
      // A request that claimed the passage again since will post these asks or fail them itself
      if (await UnpackPassageExplanation.exists({ passageKey })) return
      const ask = await UnpackRequest.findOneAndUpdate(
        { _id, status: 'previewed', destinations: 'privateChat' },
        { $pull: { destinations: 'privateChat' } }
      )
      if (ask && event) {
        await postToPrivateChat(event, ask.user, { message: UNPACK_FAILED_REPLY, messageType: 'text' })
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

/** Waits for another request's write, and takes it over if that write stalls before the deadline. */
async function waitForExplanation(
  conversation,
  passage: UnpackPassage,
  deadline: number
): Promise<ReadyUnpackPassageExplanation> {
  const startedAt = Date.now()
  while (Date.now() < deadline) {
    const pollMs = Date.now() - startedAt < UNPACK_WAIT_FAST_POLLING_MS ? UNPACK_WAIT_POLL_MS : UNPACK_WAIT_SLOW_POLL_MS
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())))
    const explanation = await UnpackPassageExplanation.findOne({ passageKey: passage.key })
    if (!explanation) throw unpackFailed()
    if (isReady(explanation)) return explanation
    if (isStale(explanation)) {
      const claim = await claimExplanation(conversation._id, passage)
      if (claim.mustWrite) {
        const writing = writeExplanation(conversation, claim.explanation, passage, new Date())
        track(writing)
        const { ready } = await beforeDeadline(writing, deadline)
        if (ready) return ready
      }
    }
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
    const llm = await getBedrockChat(UNPACK_MODEL, { maxTokens: UNPACK_MAX_OUTPUT_TOKENS })
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
  const ask = await findOrCreateAsk(conversation._id, user, passage)
  if (await needsModelCall(passage.key)) await enforceModelCallLimit(ask)
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
    explanation = await waitForExplanation(conversation, passage, deadline)
    if (cache === 'hit') cache = 'shared'
  } else if (cache === 'hit') {
    runInBackground(rewriteWithFullerContext(conversation, explanation, passage), `fuller explanation of ${passage.key}`)
  }

  logger.info(
    `unpack: preview ${conversation._id} cache=${cache} model=${UNPACK_MODEL} totalMs=${
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
  // Group Chat posts go through sharePassage, from a card the participant has already read
  destination: Extract<UnpackDestination, 'privateChat'>,
  transcriptPasscode?: string
) => {
  const event = await loadEventToPostIn(conversationId, user, transcriptPasscode)
  const passage = await resolvePassage(event.conversation._id, selection)
  const ask = await findOrCreateAsk(event.conversation._id, user, passage)

  let storedDestination = false
  if (ask.status === 'previewed') {
    if (await needsModelCall(passage.key)) await enforceModelCallLimit(ask)
    const stored = await UnpackRequest.updateOne(
      { _id: ask._id, status: 'previewed' },
      { $addToSet: { destinations: destination } }
    )
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
  // `sent` is set before the card is saved, so a post still running elsewhere could yet fail and be undone
  if (latest?.status === 'sent' && latest.answerMessage && (await cardSaved(latest.conversation, latest.answerMessage))) {
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
    { _id: askId, status: 'previewed', destinations: 'privateChat' },
    { $pull: { destinations: 'privateChat' } }
  )
  if (ask) await postToPrivateChat(event, ask.user, { message: UNPACK_FAILED_REPLY, messageType: 'text' })
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
  if (!ask || ask.status !== 'previewed' || !ask.destinations.includes('privateChat') || !ask.range) return
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

// The post carries the participant's name, so the footer says the words are the assistant's, not theirs
function toGroupChatCard(card: UnpackExplanation, assistant, pseudonym: string): UnpackExplanation {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { groupChatShare, sharingDisabled: _sharingDisabled, ...shared } = card
  const footer = `${pseudonym} shared this explanation from ${assistant.agentConfig.botName}.`
  return { ...shared, destination: 'groupChat', footer, text: `${card.text}\n\n${footer}` }
}

/** Saves the share's result on the participant's card, so clients can show it after a reload. */
async function saveShareOnCard(conversationId: mongoose.Types.ObjectId, cardId: mongoose.Types.ObjectId, result) {
  const groupChatShare: UnpackExplanation['groupChatShare'] = {
    status: result.status,
    messageId: result.messageId,
    ...(result.text && { text: result.text })
  }
  try {
    await Message.updateOne(
      { _id: cardId, conversation: conversationId },
      { $set: { 'body.groupChatShare': groupChatShare } }
    )
  } catch (error) {
    // The share already happened, so the participant still gets its answer
    logger.error(`unpack: could not save the Group Chat share on card ${cardId}`, error)
  }
}

// One ask is one participant's card for one passage, so each ask has at most one Group Chat post
const groupChatPostId = (askId: mongoose.Types.ObjectId) => stableMessageId('unpackGroupChatPost', askId)

function sentToGroupChat(askId: mongoose.Types.ObjectId, messageId: mongoose.Types.ObjectId) {
  return { askId: askId.toString(), status: 'sent', messageId: messageId.toString() }
}

/**
 * Finds a finished post that overlaps these chunks, waiting only while every overlapping post is still `posting`,
 * so a share never links to a post that then fails.
 */
async function waitForGroupPost(chunkIds: mongoose.Types.ObjectId[], deadline: number) {
  for (;;) {
    const overlapping = await UnpackGroupPost.find({ chunkIds: { $in: chunkIds } }).sort({ createdAt: 1, _id: 1 })
    const posted = overlapping.find(({ status }) => status === 'posted')
    if (posted || overlapping.length === 0) return posted ?? null
    if (Date.now() >= deadline) throw unpackFailed()
    await sleep(Math.min(UNPACK_WAIT_POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

/**
 * A row a stopped server left at `posting` would block its passage for good, so once it is stale it is settled:
 * marked posted when its message was saved, and removed when it wasn't.
 */
async function settleAbandonedGroupPosts(conversationId: mongoose.Types.ObjectId, chunkIds: mongoose.Types.ObjectId[]) {
  const staleBefore = new Date(Date.now() - UNPACK_TIMING.staleGroupPostMs)
  const abandoned = await UnpackGroupPost.find({
    chunkIds: { $in: chunkIds },
    status: 'posting',
    createdAt: { $lt: staleBefore }
  })
  for (const row of abandoned) {
    if (await cardSaved(conversationId, row.message)) {
      await UnpackGroupPost.updateOne({ _id: row._id, status: 'posting' }, { status: 'posted' })
    } else {
      await UnpackGroupPost.deleteOne({ _id: row._id, status: 'posting' })
    }
  }
}

/**
 * Removes the rows of finished overlapping posts whose author a moderator has since hidden with hide-all, so those
 * posts stop blocking the passage, like a share by an already-hidden author that saves no row. A post also hidden on
 * its own keeps its row, since that hide blocks the passage.
 */
async function releaseHiddenAuthorsPosts(
  conversationId: mongoose.Types.ObjectId,
  chunkIds: mongoose.Types.ObjectId[],
  hiddenAuthors: Set<string>
) {
  if (hiddenAuthors.size === 0) return
  const rows = await UnpackGroupPost.find({ chunkIds: { $in: chunkIds }, status: 'posted' })
    .select('message')
    .lean()
  if (rows.length === 0) return
  const released = await Message.find({
    _id: { $in: rows.map(({ message }) => message) },
    conversation: conversationId,
    owner: { $in: [...hiddenAuthors] },
    hiddenByAdmin: { $ne: true }
  })
    .select('_id')
    .lean()
  if (released.length === 0) return
  await UnpackGroupPost.deleteMany({ status: 'posted', message: { $in: released.map(({ _id }) => _id) } })
}

/** Group Chat Unpacker posts a moderator hid on their own that cover any of these chunks. */
function findSingleHiddenGroupPosts(conversationId: mongoose.Types.ObjectId, chunkIds: string[]) {
  return Message.find({
    conversation: conversationId,
    bodyType: 'json',
    'body.type': 'unpack_explanation',
    'body.destination': 'groupChat',
    hiddenByAdmin: true,
    'body.chunkIds': { $in: chunkIds }
  })
    .select('_id body.chunkIds')
    .lean()
}

/**
 * Whether a card overlaps a post hidden on its own. The card that made the post doesn't count: its author still sees
 * their post, so marking their card would tell them it was hidden.
 */
function blocksCard(hiddenPosts, card: UnpackExplanation) {
  const ownPost = card.groupChatShare?.status === 'sent' ? card.groupChatShare.messageId : null
  return hiddenPosts.some(
    ({ _id, body }) => _id.toString() !== ownPost && body.chunkIds.some((id) => card.chunkIds.includes(id))
  )
}

async function isSharingDisabled(conversationId: mongoose.Types.ObjectId, card: UnpackExplanation) {
  return blocksCard(await findSingleHiddenGroupPosts(conversationId, card.chunkIds), card)
}

/**
 * Marks the Private Chat cards that overlap a Group Chat post after a moderator hides or unhides it on its own, and
 * clears the mark once no hidden post overlaps a card. Does nothing for any other message.
 */
async function refreshSharingDisabled(messageId: mongoose.Types.ObjectId | string) {
  const post = await Message.findOne({
    _id: messageId,
    bodyType: 'json',
    'body.type': 'unpack_explanation',
    'body.destination': 'groupChat'
  })
    .select('conversation body.chunkIds')
    .lean<{ conversation: mongoose.Types.ObjectId; body: UnpackExplanation }>()
  if (!post) return
  const conversationId = post.conversation
  const cards = await Message.find({
    conversation: conversationId,
    bodyType: 'json',
    'body.type': 'unpack_explanation',
    'body.destination': 'privateChat',
    'body.chunkIds': { $in: post.body.chunkIds }
  })
    .select('body.chunkIds body.groupChatShare')
    .lean<{ _id: mongoose.Types.ObjectId; body: UnpackExplanation }[]>()
  if (cards.length === 0) return
  const hiddenPosts = await findSingleHiddenGroupPosts(
    conversationId,
    cards.flatMap(({ body }) => body.chunkIds)
  )
  const blocked = cards.filter(({ body }) => blocksCard(hiddenPosts, body))
  const open = cards.filter((card) => !blocked.includes(card))
  await Message.updateMany({ _id: { $in: blocked.map(({ _id }) => _id) } }, { $set: { 'body.sharingDisabled': true } })
  await Message.updateMany({ _id: { $in: open.map(({ _id }) => _id) } }, { $unset: { 'body.sharingDisabled': 1 } })
}

/** Takes this participant's one Group Chat post for the window, and returns a function that gives it back. */
function takeGroupChatSlot(key: string) {
  const now = Date.now()
  for (const [otherKey, postedAt] of lastGroupChatPosts) {
    if (now - postedAt >= UNPACK_GROUP_CHAT_POST_WINDOW_MS) lastGroupChatPosts.delete(otherKey)
  }
  if (lastGroupChatPosts.has(key)) {
    throw unpackError(
      httpStatus.TOO_MANY_REQUESTS,
      'groupChatRateLimited',
      `You can post to Group Chat once every ${UNPACK_GROUP_CHAT_POST_WINDOW_MS / 60000} minutes. Try again shortly.`
    )
  }
  lastGroupChatPosts.set(key, now)
  return () => {
    if (lastGroupChatPosts.get(key) === now) lastGroupChatPosts.delete(key)
  }
}

function alreadyPosted(askId: mongoose.Types.ObjectId, existingMessageId) {
  return {
    askId: askId.toString(),
    status: 'alreadyPosted',
    messageId: existingMessageId.toString(),
    text: UNPACK_ALREADY_POSTED_TEXT
  }
}

/**
 * Posts the card as the participant's own Group Chat message and records Group Chat on the ask. When the transcript
 * was cleared while it posted, it removes the post and throws; when its row was taken for abandoned mid-post, it
 * removes the post and returns null. A hidden participant's post has no `rowId`, since it saves no row.
 */
async function postGroupCard(
  event: UnpackEvent,
  groupChat,
  user,
  askId: mongoose.Types.ObjectId,
  card: UnpackExplanation,
  { giveSlotBack, rowId }: { giveSlotBack: () => void; rowId? }
) {
  const conversationId = event.conversation._id
  const chunkIds = card.chunkIds.map((id) => new mongoose.Types.ObjectId(id))
  const messageId = groupChatPostId(askId)
  const forget = async () => {
    if (rowId) await UnpackGroupPost.deleteOne({ _id: rowId })
  }
  try {
    await messageService.newMessageHandler(
      {
        _id: messageId,
        conversation: conversationId,
        body: card,
        bodyType: 'json',
        channels: [groupChat],
        // Adapters forward to chats that can't draw a card, such as Zoom, so they get a short text version
        parseOutput: (saved) => ({
          ...saved.toObject(),
          bodyType: 'text',
          body: toSharedChatText(card, event.assistant.agentConfig.botName)
        })
      },
      user,
      null,
      { serverCard: true }
    )
  } catch (error) {
    if (isDuplicateKey(error)) {
      // Another request for this same card saved the post first, so this one posted nothing
      giveSlotBack()
    } else if (!(await cardSaved(conversationId, messageId))) {
      await forget()
      giveSlotBack()
      throw error
    } else {
      logger.error(`unpack: Group Chat post ${messageId} was saved, but posting it then failed`, error)
    }
  }
  const ours = !rowId || (await UnpackGroupPost.updateOne({ _id: rowId }, { status: 'posted' })).matchedCount === 1
  // Clearing the transcript while this was posting deletes the rows, but not a post saved after it ran
  const chunksSaved = await chunksStillSaved(conversationId, chunkIds)
  if (!ours || !chunksSaved) {
    await transcript.deleteUnpackCards(conversationId, { _id: messageId })
    await forget()
    giveSlotBack()
    if (!chunksSaved) throw transcriptGone()
    return null
  }
  await UnpackRequest.updateOne({ _id: askId }, { $addToSet: { destinations: 'groupChat' } })
  return sentToGroupChat(askId, messageId)
}

/**
 * Saves the row before posting, so when two people post the same passage at once, the unique index refuses the
 * second. Returns null when another post got in first, including one that took this row for abandoned mid-post.
 */
async function tryToPostToGroupChat(event: UnpackEvent, groupChat, user, askId: mongoose.Types.ObjectId, card) {
  const giveSlotBack = takeGroupChatSlot(`${event.conversation._id}:${user._id}`)
  let row
  try {
    row = await UnpackGroupPost.create({
      conversation: event.conversation._id,
      ask: askId,
      chunkIds: card.chunkIds.map((id) => new mongoose.Types.ObjectId(id)),
      message: groupChatPostId(askId),
      status: 'posting'
    })
  } catch (error) {
    giveSlotBack()
    if (isDuplicateKey(error)) return null
    throw error
  }
  return postGroupCard(event, groupChat, user, askId, card, { giveSlotBack, rowId: row._id })
}

/**
 * Posts a card to Group Chat unless a post already covers any of its chunks. A post a moderator hid on its own blocks
 * the passage until it is unhidden. A post hidden only by hiding every post by its author blocks nobody: a share by a
 * hidden author saves no row, and a row saved before the hide is removed here.
 */
async function postToGroupChat(event: UnpackEvent, groupChat, user, askId: mongoose.Types.ObjectId, card) {
  const conversationId = event.conversation._id
  const chunkIds = card.chunkIds.map((id) => new mongoose.Types.ObjectId(id))
  const { hiddenAuthors, hiddenIds } = await loadHideContext(conversationId)
  const userIsHidden = hiddenAuthors.has(user._id.toString())
  const ownPostId = groupChatPostId(askId)
  // A hidden post may have no row, so its author's repeat share finds it by its ID instead
  if (hiddenIds.has(ownPostId.toString())) return sentToGroupChat(askId, ownPostId)
  const singleHidden = await findSingleHiddenGroupPosts(conversationId, card.chunkIds)
  if (singleHidden.some(({ _id }) => !_id.equals(ownPostId))) throw sharingDisabled()
  const deadline = Date.now() + UNPACK_TIMING.groupPostWaitMs
  for (;;) {
    await settleAbandonedGroupPosts(conversationId, chunkIds)
    await releaseHiddenAuthorsPosts(conversationId, chunkIds, hiddenAuthors)
    const existing = await waitForGroupPost(chunkIds, deadline)
    if (existing?.ask.equals(askId)) return sentToGroupChat(askId, existing.message)
    if (existing) return alreadyPosted(askId, existing.message)
    if (userIsHidden) {
      const giveSlotBack = takeGroupChatSlot(`${conversationId}:${user._id}`)
      return postGroupCard(event, groupChat, user, askId, card, { giveSlotBack })
    }
    const posted = await tryToPostToGroupChat(event, groupChat, user, askId, card)
    if (posted) return posted
    if (Date.now() >= deadline) throw unpackFailed()
  }
}

/**
 * Shares a participant's Private Chat card to Group Chat under their pseudonym. It copies the card as they saw it,
 * even if the saved explanation was rewritten since, so the room gets exactly what they chose to share.
 */
const sharePassage = async (
  conversationId: string,
  user,
  messageId: string,
  { transcriptPasscode, chatPasscode }: { transcriptPasscode?: string; chatPasscode?: string } = {}
) => {
  const event = await loadEventToPostIn(conversationId, user, transcriptPasscode)
  if (isPreEventWindowOpen(event.conversation)) {
    throw unpackError(httpStatus.CONFLICT, 'eventNotStarted', 'You can share to Group Chat once the event starts.')
  }
  // Starting an event again doesn't clear its end time, so only an inactive event with one has ended
  if (event.conversation.endTime && !event.conversation.active) {
    throw unpackError(
      httpStatus.CONFLICT,
      'eventEnded',
      'This event has ended, so nothing more can be shared to Group Chat.'
    )
  }
  const groupChat = await findGroupChat(event.conversation, chatPasscode)
  const ask = await UnpackRequest.findOne({
    conversation: event.conversation._id,
    user: user._id,
    mode: 'passage',
    answerMessage: messageId
  })
  if (!ask) throw cardNotFound()
  const [card] = await findMessages(
    event.conversation._id,
    'admin',
    { _id: ask.answerMessage, bodyType: 'json', 'body.type': 'unpack_explanation' },
    { lean: true }
  )
  if (!card) throw cardNotFound()
  const { pseudonym } = resolveDisplayName(user, event.conversation)
  const result = await postToGroupChat(
    event,
    groupChat,
    user,
    ask._id,
    toGroupChatCard(card.body, event.assistant, pseudonym)
  )
  await saveShareOnCard(event.conversation._id, card._id, result)
  return result
}

export default { previewPassage, sendPassage, sharePassage, finishPendingAsk, refreshSharingDisabled }
