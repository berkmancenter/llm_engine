import httpStatus from 'http-status'
import mongoose from 'mongoose'
import config from '../config/config.js'
import logger from '../config/logger.js'
import { Conversation, UnpackExplanation, UnpackRequest } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import assertMembership from '../utils/assertMembership.js'
import { findMessages } from '../utils/messageVisibility.js'
import { getBedrockChat } from '../agents/helpers/getModelChat.js'
import { buildPassage, explainPassage, getPassageContext } from '../agents/eventAssistant/unpackPassage.js'
import { isUnpackerEnabled, toPlainText, UNPACK_REPLIES } from '../agents/eventAssistant/unpackHandler.js'
import messageService, { agentResponseToMessageData } from './message.service.js'
import {
  IUnpackExplanation,
  UnpackDestination,
  UnpackExplanation as UnpackExplanationCard,
  UnpackPassage,
  UnpackRange
} from '../types/index.types.js'

// Higher than the "Catch me up" limit because the website previews as soon as a selection settles
export const UNPACK_PREVIEWS_PER_MINUTE = 10
const UNPACK_WAIT_POLL_MS = 250
const UNPACK_WAIT_LIMIT_MS = 30 * 1000
// A row still generating after this long was most likely left behind by a server that stopped
const UNPACK_STALE_GENERATION_MS = 60 * 1000
// About two and a half times a typical answer; a shorter answer is a shorter wait for the participant
const UNPACK_MAX_OUTPUT_TOKENS = 1000

const backgroundWork = new Set<Promise<unknown>>()

function unpackError(status: number, reason: string, message: string) {
  return new ApiError(status, message, { reason })
}

const unpackFailed = () =>
  unpackError(httpStatus.SERVICE_UNAVAILABLE, 'unpackFailed', "Berkie couldn't explain that just now. Try again.")

function runInBackground(work: Promise<unknown>, description: string) {
  const tracked = work
    .catch((error) => logger.error(`unpack: ${description} failed`, error))
    .finally(() => backgroundWork.delete(tracked))
  backgroundWork.add(tracked)
}

/** Background explanations outlive the request that started them; this waits for every one still running. */
export async function settleBackgroundUnpacks() {
  while (backgroundWork.size > 0) await Promise.allSettled([...backgroundWork])
}

async function checkPreviewLimit(conversationId: string, user) {
  const recentPassages = await UnpackRequest.countDocuments({
    conversation: conversationId,
    user: user._id,
    passageKey: { $type: 'string' },
    createdAt: { $gte: new Date(Date.now() - 60 * 1000) }
  })
  if (recentPassages >= UNPACK_PREVIEWS_PER_MINUTE) {
    throw unpackError(
      httpStatus.TOO_MANY_REQUESTS,
      'rateLimited',
      'Too many passages in the last minute. Try again shortly.'
    )
  }
}

function findBerkie(conversation) {
  return conversation.agents.find((agent) => agent.agentType === 'eventAssistant')
}

function findPrivateChat(conversation, userId: mongoose.Types.ObjectId, berkie) {
  return conversation.channels.find((channel) => {
    const participants = (channel.participants ?? []).map((id) => id.toString())
    return channel.direct && participants.includes(userId.toString()) && participants.includes(berkie._id.toString())
  })
}

async function loadEvent(conversationId: string, user) {
  const conversation = await Conversation.findById(conversationId).populate(['agents', 'channels'])
  if (!conversation) throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  if (!isUnpackerEnabled(conversation)) {
    throw unpackError(httpStatus.FORBIDDEN, 'unpackerOff', 'The Unpacker is not turned on for this event.')
  }
  await assertMembership(user, conversation)
  const berkie = findBerkie(conversation)
  if (!berkie) throw unpackError(httpStatus.CONFLICT, 'noAssistant', 'This event has no assistant to explain the talk.')
  return { conversation, berkie }
}

async function resolvePassage(conversationId: mongoose.Types.ObjectId, selection: UnpackRange): Promise<UnpackPassage> {
  const ends = await findMessages(
    conversationId,
    'model',
    { _id: { $in: [selection.startMessageId, selection.endMessageId] }, channels: 'transcript' },
    { select: 'createdAt', lean: true }
  )
  const times = ends.map(({ createdAt }) => createdAt.getTime())
  const transcript =
    ends.length === 0
      ? []
      : await findMessages(
          conversationId,
          'model',
          { channels: 'transcript', createdAt: { $gte: new Date(Math.min(...times)), $lte: new Date(Math.max(...times)) } },
          { select: 'body createdAt', sort: { createdAt: 1, _id: 1 }, lean: true }
        )
  return buildPassage(transcript, selection)
}

const isDuplicateKey = (error) => error?.code === 11000

/**
 * Finds the shared explanation for a passage, or claims the right to write it. Only one request can claim a
 * passage, through the unique passage key, so two people asking at once make one AI model call.
 */
async function claimExplanation(conversationId: mongoose.Types.ObjectId, passage: UnpackPassage) {
  const existing = await UnpackExplanation.findOne({ passageKey: passage.key })
  if (!existing) {
    const first = passage.pieces[0].chunk
    const last = passage.pieces[passage.pieces.length - 1].chunk
    try {
      const claimed = await UnpackExplanation.create({
        conversation: conversationId,
        passageKey: passage.key,
        range: passage.range,
        chunkIds: passage.pieces.map(({ chunk }) => chunk._id),
        quote: passage.quote,
        passage: { start: first.createdAt, end: last.createdAt },
        status: 'generating',
        generatingSince: new Date()
      })
      return { explanation: claimed, mustWrite: true }
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      return claimExplanation(conversationId, passage)
    }
  }
  const staleBefore = new Date(Date.now() - UNPACK_STALE_GENERATION_MS)
  if (existing.status === 'generating' && existing.generatingSince! < staleBefore) {
    const takenOver = await UnpackExplanation.findOneAndUpdate(
      { _id: existing._id, status: 'generating', generatingSince: existing.generatingSince },
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
  try {
    return await UnpackRequest.create({
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
    return UnpackRequest.findOne({ user: user._id, passageKey: passage.key })
  }
}

function toCard(explanation: IUnpackExplanation, destination: UnpackDestination): UnpackExplanationCard {
  const { whatTheyreSaying, whyItMatters, terms, headline, range } = explanation
  const sections = { whatTheyreSaying: whatTheyreSaying!, whyItMatters: whyItMatters!, terms: terms ?? [] }
  return {
    type: 'unpack_explanation',
    mode: 'passage',
    destination,
    chunkIds: explanation.chunkIds.map((id) => id.toString()),
    passage: { start: explanation.passage!.start.toISOString(), end: explanation.passage!.end.toISOString() },
    quote: explanation.quote,
    ...sections,
    headline,
    range: range && {
      startMessageId: range.startMessageId.toString(),
      startOffset: range.startOffset,
      endMessageId: range.endMessageId.toString(),
      endOffset: range.endOffset
    },
    text: toPlainText(sections)
  }
}

function toPreview(explanation: IUnpackExplanation) {
  const { range, chunkIds, passage, quote, whatTheyreSaying, whyItMatters, terms, headline } = toCard(
    explanation,
    'privateChat'
  )
  const visual = explanation.visual ?? null
  return { range, chunkIds, passage, quote, whatTheyreSaying, whyItMatters, terms, headline, visual }
}

async function postToPrivateChat(conversationId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, response) {
  const conversation = await Conversation.findById(conversationId).populate(['agents', 'channels'])
  const berkie = conversation && findBerkie(conversation)
  const channel = berkie && findPrivateChat(conversation, userId, berkie)
  if (!channel) {
    logger.warn(`unpack: no Private Chat for user ${userId} in ${conversationId}, so nothing was posted`)
    return
  }
  await messageService.newMessageHandler(
    agentResponseToMessageData({ visible: true, ...response, channels: [channel] }, berkie),
    berkie
  )
}

async function startWholeChunkExplanations(conversation, chunkIds: mongoose.Types.ObjectId[]) {
  const chunks = await findMessages(
    conversation._id,
    'model',
    { _id: { $in: chunkIds }, channels: 'transcript' },
    { select: 'body createdAt', lean: true }
  )
  for (const chunk of chunks) {
    const id = chunk._id.toString()
    const passage = buildPassage([chunk], {
      startMessageId: id,
      startOffset: 0,
      endMessageId: id,
      endOffset: chunk.body.length
    })
    const claim = await claimExplanation(conversation._id, passage)
    if (claim.mustWrite) {
      runInBackground(
        // These two call each other (writing posts cards, posting starts more writes), so one is used before it's defined
        // eslint-disable-next-line no-use-before-define
        writeExplanation(conversation, claim.explanation, passage, new Date()),
        `whole-chunk explanation of ${id}`
      )
    }
  }
}

/** Posts one ask's card, unless another request already has. Claiming the ask first makes the post happen once. */
async function postAsk(askId: mongoose.Types.ObjectId, explanation: IUnpackExplanation) {
  const answerId = new mongoose.Types.ObjectId()
  const ask = await UnpackRequest.findOneAndUpdate(
    { _id: askId, status: 'previewed', destination: { $exists: true } },
    { status: 'sent', answerMessage: answerId, explanation: explanation._id },
    { new: true }
  )
  if (!ask) return
  try {
    await postToPrivateChat(ask.conversation, ask.user, {
      message: toCard(explanation, ask.destination!),
      messageType: 'json',
      messageId: answerId
    })
    const conversation = await Conversation.findById(ask.conversation).select('name')
    runInBackground(startWholeChunkExplanations(conversation, ask.chunkIds), `whole-chunk explanations for ask ${askId}`)
  } catch (error) {
    logger.error(`unpack: could not post ask ${askId} in ${ask.conversation}`, error)
  }
}

async function postWaitingAsks(explanation: IUnpackExplanation) {
  const waiting = await UnpackRequest.find({
    passageKey: explanation.passageKey,
    status: 'previewed',
    destination: { $exists: true }
  }).select('_id')
  for (const { _id } of waiting) await postAsk(_id, explanation)
}

async function failWaitingAsks(passageKey: string) {
  const waiting = await UnpackRequest.find({ passageKey, status: 'previewed', destination: { $exists: true } }).select('_id')
  for (const { _id } of waiting) {
    const ask = await UnpackRequest.findOneAndUpdate(
      { _id, status: 'previewed', destination: { $exists: true } },
      { $unset: { destination: 1 } }
    )
    if (ask) await postToPrivateChat(ask.conversation, ask.user, { message: UNPACK_REPLIES.failed, messageType: 'text' })
  }
}

/**
 * Writes a claimed explanation with the AI model, then posts it for everyone who already picked a destination.
 * On failure the claim is dropped so the next request tries again, and those people are told it failed.
 */
async function writeExplanation(conversation, claimed: IUnpackExplanation, passage: UnpackPassage, askedAt: Date) {
  let ready: IUnpackExplanation | null
  let modelMs = 0
  try {
    const context = await getPassageContext(conversation._id, passage, askedAt)
    const llm = await getBedrockChat(config.unpackLLMModel, { maxTokens: UNPACK_MAX_OUTPUT_TOKENS })
    const modelStartedAt = Date.now()
    const sections = await explainPassage(llm, { topic: conversation.name, passage, ...context })
    modelMs = Date.now() - modelStartedAt
    ready = await UnpackExplanation.findOneAndUpdate(
      { _id: claimed._id },
      { ...sections, status: 'ready', $unset: { generatingSince: 1 } },
      { new: true }
    )
  } catch (error) {
    logger.error(`unpack: could not explain passage ${passage.key} in ${conversation._id}`, error)
    await UnpackExplanation.deleteOne({ _id: claimed._id, status: 'generating' })
    await failWaitingAsks(passage.key)
    throw unpackFailed()
  }
  if (!ready) throw unpackFailed()
  await postWaitingAsks(ready)
  return { ready, modelMs }
}

async function waitForExplanation(passageKey: string): Promise<IUnpackExplanation> {
  const giveUpAt = Date.now() + UNPACK_WAIT_LIMIT_MS
  while (Date.now() < giveUpAt) {
    await new Promise((resolve) => setTimeout(resolve, UNPACK_WAIT_POLL_MS))
    const explanation = await UnpackExplanation.findOne({ passageKey })
    if (!explanation) throw unpackFailed()
    if (explanation.status === 'ready') return explanation
  }
  throw unpackFailed()
}

/**
 * Explains a passage the participant selected, reusing a saved explanation when there is one, and records
 * their ask so a later send posts exactly this explanation.
 */
const previewPassage = async (conversationId: string, user, selection: UnpackRange) => {
  const startedAt = Date.now()
  await checkPreviewLimit(conversationId, user)
  const { conversation } = await loadEvent(conversationId, user)
  const passage = await resolvePassage(conversation._id, selection)
  const claim = await claimExplanation(conversation._id, passage)
  const ask = await findOrCreateAsk(conversation._id, user, passage)

  let { explanation }: { explanation: IUnpackExplanation } = claim
  let cache = 'hit'
  let modelMs = 0
  if (claim.mustWrite) {
    ;({ ready: explanation, modelMs } = await writeExplanation(
      conversation,
      claim.explanation,
      passage,
      new Date(startedAt)
    ))
    cache = 'miss'
  } else if (explanation.status !== 'ready') {
    explanation = await waitForExplanation(passage.key)
    cache = 'shared'
  }

  logger.info(
    `unpack: preview ${conversation._id} cache=${cache} model=${config.unpackLLMModel} totalMs=${
      Date.now() - startedAt
    } modelMs=${modelMs}`
  )
  return { askId: ask!._id.toString(), explanation: toPreview(explanation) }
}

/**
 * Sends a passage's explanation to the participant's chosen destination. Works before or without a preview: the
 * choice is stored on the ask and the card posts as soon as the explanation is ready.
 */
const sendPassage = async (conversationId: string, user, selection: UnpackRange, destination: UnpackDestination) => {
  const { conversation, berkie } = await loadEvent(conversationId, user)
  if (!findPrivateChat(conversation, user._id, berkie)) {
    throw unpackError(httpStatus.CONFLICT, 'noPrivateChat', 'You have no Private Chat with the assistant in this event yet.')
  }
  const passage = await resolvePassage(conversation._id, selection)
  const previewed = await UnpackRequest.findOne({ user: user._id, passageKey: passage.key })
  if (!previewed) await checkPreviewLimit(conversationId, user)
  const claim = await claimExplanation(conversation._id, passage)
  const ask = previewed ?? (await findOrCreateAsk(conversation._id, user, passage))

  if (ask!.status === 'previewed') {
    await UnpackRequest.updateOne({ _id: ask!._id, status: 'previewed' }, { destination })
    if (claim.mustWrite) {
      runInBackground(
        writeExplanation(conversation, claim.explanation, passage, new Date()),
        `explanation of ${passage.key}`
      )
    }
    // Checked after storing the destination, so a write that finished in between can't miss this ask
    const current = await UnpackExplanation.findOne({ passageKey: passage.key })
    if (current?.status === 'ready') await postAsk(ask!._id, current)
  }

  const latest = await UnpackRequest.findById(ask!._id)
  if (latest?.status === 'sent') {
    return { askId: latest._id.toString(), status: 'sent', messageId: latest.answerMessage?.toString() }
  }
  return { askId: ask!._id.toString(), status: 'pending' }
}

export default { previewPassage, sendPassage }
