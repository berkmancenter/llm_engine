import httpStatus from 'http-status'
import mongoose from 'mongoose'
import logger from '../config/logger.js'
import { Conversation, Message, ModerationEvent, User } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import websocketGateway from '../websockets/websocketGateway.js'
import { HIDEABLE_CHANNEL, HideContext, inHideableChannel, loadHideContext } from '../utils/messageVisibility.js'

/**
 * Admin moderation: hide a message, or every message by one author, in ONE conversation, and undo it.
 * Scope is the group `chat` channel only: messages elsewhere (e.g. a participant's private assistant
 * channel) are never hidden, and hiding a single message outside `chat` is a 400.
 *
 * Hidden messages stay visible to admins (flagged) and to their own author (shadow-hide); everyone
 * else stops seeing them, replies included. The rules live in utils/messageVisibility.ts; this file
 * only changes state and tells clients which concrete message ids changed.
 *
 * ADAPTERS CANNOT BE RECALLED. A message that was already forwarded to an external platform
 * (Slack, Zoom, ...) before it was hidden stays visible there; hiding only affects what this
 * service serves and broadcasts. Messages created while their author is hidden (or as a reply under
 * a hidden message) are never forwarded (see newMessageHandler), but nothing can undo a forward that
 * already happened. Callers and moderators should treat hiding as "hidden in the app", not "deleted".
 */

const assertAdmin = (requester) => {
  // Current role, not the token's: `requester` is loaded fresh from the database on every request.
  if (requester?.role !== 'admin') throw new ApiError(httpStatus.FORBIDDEN, 'Forbidden')
}

const diff = (from: Set<string>, to: Set<string>) => [...to].filter((id) => !from.has(id))

/** Tell clients which message ids changed state, once the new state is stored. */
const announce = async (conversationId: string, before: HideContext, after: HideContext) => {
  const newlyHidden = diff(before.hiddenIds, after.hiddenIds)
  const newlyVisible = diff(after.hiddenIds, before.hiddenIds)
  const { display } = after

  if (newlyHidden.length) {
    const rows = await Message.find({ _id: { $in: newlyHidden } })
      .select('channels')
      .lean()
    const channels = [...new Set(rows.flatMap((row) => row.channels ?? []))]
    await websocketGateway.broadcastMessagesHidden(
      conversationId,
      { messageIds: newlyHidden, hidden: true, display },
      channels
    )
  }
  if (newlyVisible.length) {
    await websocketGateway.broadcastMessagesHidden(conversationId, { messageIds: newlyVisible, hidden: false, display })
    // Non-admins get the restored messages through the normal new-message path. Backchannel
    // (`visible: false`) messages were never shared in the first place.
    const restored = await Message.find({ _id: { $in: newlyVisible }, visible: true }).sort({ createdAt: 1 })
    for (const message of restored) {
      await websocketGateway.broadcastNewMessage(message, null, after)
    }
  }
}

const loadMessage = async (messageId) => {
  if (!mongoose.isValidObjectId(messageId)) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found')
  const message = await Message.findById(messageId).select('conversation owner parentMessage hiddenByAdmin channels')
  if (!message) throw new ApiError(httpStatus.NOT_FOUND, 'Message not found')
  return message
}

/**
 * Order of operations, and why: apply the change, work out which ids actually changed by diffing the
 * hidden state before and after, write the audit event, and only then tell clients. If the audit write
 * fails the change is put back and the call fails, so a hide is never applied without a record (and no
 * client was told about it yet). Mongo is used here without multi-document transactions, so this
 * compensating revert is what keeps the two in step; the revert is one idempotent update.
 */
const recordEvent = async (event, revert: () => Promise<unknown>) => {
  try {
    await ModerationEvent.create(event)
  } catch (err) {
    try {
      await revert()
    } catch (revertErr) {
      logger.error(`Could not revert a hide after its audit event failed to save: ${revertErr.message}`)
    }
    throw err
  }
}

const setMessageHidden = async (messageId, requester, hidden: boolean, reason?: string) => {
  assertAdmin(requester)
  const message = await loadMessage(messageId)
  // Hiding is a group chat feature: refuse rather than silently doing nothing for another channel.
  if (hidden && !inHideableChannel(message)) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Only messages in the ${HIDEABLE_CHANNEL} channel can be hidden.`)
  }
  const conversationId = message.conversation.toString()
  const wasFlagged = !!message.hiddenByAdmin
  const before = await loadHideContext(conversationId)
  await Message.updateOne({ _id: message._id }, { $set: { hiddenByAdmin: hidden } })
  const after = await loadHideContext(conversationId)

  const messageIds = hidden ? diff(before.hiddenIds, after.hiddenIds) : diff(after.hiddenIds, before.hiddenIds)
  const ownerId = message.owner?.toString()
  // A no-op (already in that state) writes no event and sends nothing.
  if (wasFlagged !== hidden || messageIds.length) {
    await recordEvent(
      {
        conversation: conversationId,
        actor: requester._id,
        action: hidden ? 'hide' : 'unhide',
        scope: 'message',
        targetMessage: message._id,
        ...(ownerId && { targetUser: ownerId }),
        messageIds,
        ...(reason && { reason })
      },
      () => Message.updateOne({ _id: message._id }, { $set: { hiddenByAdmin: wasFlagged } })
    )
  }
  await announce(conversationId, before, after)

  if (hidden && ownerId && messageIds.includes(message._id.toString())) {
    await websocketGateway.broadcastHiddenNotice(conversationId, ownerId, {
      conversationId,
      scope: 'message',
      messageIds: [message._id.toString()]
    })
  }
  return { conversationId, messageIds, hidden }
}

const setAuthorHidden = async (conversationId, userId, requester, hidden: boolean, reason?: string) => {
  assertAdmin(requester)
  if (!mongoose.isValidObjectId(conversationId) || !(await Conversation.exists({ _id: conversationId }))) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }
  if (!mongoose.isValidObjectId(userId) || !(await User.exists({ _id: userId }))) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  const convId = conversationId.toString()
  const authorId = userId.toString()
  const before = await loadHideContext(convId)
  const wasHidden = before.hiddenAuthors.has(authorId)
  await Conversation.updateOne(
    { _id: convId },
    hidden ? { $addToSet: { hiddenAuthors: authorId } } : { $pull: { hiddenAuthors: authorId } }
  )
  const after = await loadHideContext(convId)

  const messageIds = hidden ? diff(before.hiddenIds, after.hiddenIds) : diff(after.hiddenIds, before.hiddenIds)
  if (wasHidden !== hidden) {
    await recordEvent(
      {
        conversation: convId,
        actor: requester._id,
        action: hidden ? 'hide' : 'unhide',
        scope: 'user',
        targetUser: authorId,
        messageIds,
        ...(reason && { reason })
      },
      () =>
        Conversation.updateOne(
          { _id: convId },
          wasHidden ? { $addToSet: { hiddenAuthors: authorId } } : { $pull: { hiddenAuthors: authorId } }
        )
    )
  }
  await announce(convId, before, after)

  if (hidden && !wasHidden) {
    // Only the author's own messages: replies by others that cascaded are not theirs to be told about.
    const own = await Message.find({ _id: { $in: messageIds }, owner: authorId })
      .select('_id')
      .lean()
    await websocketGateway.broadcastHiddenNotice(convId, authorId, {
      conversationId: convId,
      scope: 'user',
      messageIds: own.map((m) => m._id.toString())
    })
  }
  return { conversationId: convId, userId: authorId, messageIds, hidden }
}

type ActorSummary = { id: string; username?: string }

/** Newest first. Ids and the actor's username only: no bodies, no pseudonyms, no email. */
const listModerationEvents = async (conversationId, requester, options: { limit?: number; page?: number } = {}) => {
  assertAdmin(requester)
  if (!mongoose.isValidObjectId(conversationId) || !(await Conversation.exists({ _id: conversationId }))) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }
  const result = await ModerationEvent.paginate(
    { conversation: conversationId },
    { sortBy: 'createdAt:desc,_id:desc', limit: options.limit, page: options.page }
  )
  const actorIds = [...new Set(result.results.map((event) => event.actor.toString()))]
  const actors = await User.find({ _id: { $in: actorIds } })
    .select('username')
    .lean()
  const actorById = new Map<string, ActorSummary>(
    actors.map((a) => [a._id.toString(), { id: a._id.toString(), username: a.username }])
  )
  return {
    ...result,
    results: result.results.map((event) => {
      const json = event.toJSON()
      return {
        ...json,
        actor: actorById.get(event.actor.toString()) ?? { id: event.actor.toString() }
      }
    })
  }
}

const hideMessage = (messageId, requester, reason?: string) => setMessageHidden(messageId, requester, true, reason)
const unhideMessage = (messageId, requester, reason?: string) => setMessageHidden(messageId, requester, false, reason)
const hideUserMessages = (conversationId, userId, requester, reason?: string) =>
  setAuthorHidden(conversationId, userId, requester, true, reason)
const unhideUserMessages = (conversationId, userId, requester, reason?: string) =>
  setAuthorHidden(conversationId, userId, requester, false, reason)

const messageHideService = { hideMessage, unhideMessage, hideUserMessages, unhideUserMessages, listModerationEvents }
export default messageHideService
