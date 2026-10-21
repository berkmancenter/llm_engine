import { createHash } from 'crypto'
import mongoose from 'mongoose'
import Conversation from '../models/conversation.model.js'
import Message from '../models/message.model.js'

/**
 * Single source of truth for who may see an admin-hidden message.
 *
 * A message is hidden when ANY of these holds:
 *  - an admin hid it (`hiddenByAdmin`),
 *  - its author is in the conversation's `hiddenAuthors` (hide-all; covers past and future posts),
 *  - it replies, directly or transitively, to a hidden message (reply cascade).
 *
 * Every read path (history, replies, live broadcast, vote:new) decides what one viewer gets by
 * calling `viewMessageFor`; none re-implements the rules above.
 *
 * Hiding is scoped to one conversation AND to the group chat channel: a message outside `chat` (the
 * hidden author's private assistant channel, say) is never hidden, whatever the rules above say.
 *
 * Hiding is scoped to one conversation and is NOT a recall: a message already forwarded to an
 * external adapter (Slack, Zoom, ...) stays there. See the hide service.
 */

/** The only channel hiding applies to: the group chat. Messages in any other channel are never hidden. */
export const HIDEABLE_CHANNEL = 'chat'

/** Whether hiding can apply to this message at all. Channels may be names or channel objects. */
export const inHideableChannel = (message: { channels?: unknown } | null | undefined): boolean =>
  ((message?.channels as Array<string | { name?: string }> | undefined) ?? []).some(
    (channel) => (typeof channel === 'string' ? channel : channel?.name) === HIDEABLE_CHANNEL
  )

/** 'omit' drops hidden messages from non-admins' view; 'placeholder' sends a body-less stub instead. */
export type HiddenDisplay = 'omit' | 'placeholder'

/** Policy for how non-admins see hidden messages. A constant today; intended to become a per-conversation setting. */
export const hiddenDisplay: HiddenDisplay = 'omit'

export type MessageViewKind = 'full' | 'flagged' | 'stub' | 'omit'

export interface MessageViewer {
  id?: string | null
  isAdmin: boolean
}

export interface HideContext {
  /** owner ids hidden by hide-all */
  hiddenAuthors: Set<string>
  /** ids of every hidden message in the conversation, reply cascades included */
  hiddenIds: Set<string>
  display: HiddenDisplay
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const idOf = (value: any): string | undefined => {
  if (value === undefined || value === null) return undefined
  return (value._id ?? value).toString()
}

export const viewerOf = (user: any): MessageViewer => ({
  id: idOf(user),
  isAdmin: user?.role === 'admin'
})

export const emptyHideContext = (display: HiddenDisplay = hiddenDisplay): HideContext => ({
  hiddenAuthors: new Set(),
  hiddenIds: new Set(),
  display
})

export function isMessageHidden(message: any, ctx: HideContext): boolean {
  if (!inHideableChannel(message)) return false
  if (message.hiddenByAdmin) return true
  const owner = idOf(message.owner)
  if (owner && ctx.hiddenAuthors.has(owner)) return true
  const self = idOf(message._id ?? message.id)
  if (self && ctx.hiddenIds.has(self)) return true
  const parent = idOf(message.parentMessage)
  return !!parent && ctx.hiddenIds.has(parent)
}

/**
 * What one viewer gets of one message.
 *  - full:    send as is (not hidden, or the viewer wrote it: the author is shadow-hidden, never told in the payload)
 *  - flagged: send with `hidden: true` (admins)
 *  - stub:    send only the body-less stub (placeholder policy)
 *  - omit:    send nothing
 */
export function viewMessageFor(message: any, viewer: MessageViewer, ctx: HideContext): MessageViewKind {
  if (!isMessageHidden(message, ctx)) return 'full'
  if (viewer.isAdmin) return 'flagged'
  if (viewer.id && idOf(message.owner) === viewer.id) return 'full'
  return ctx.display === 'placeholder' ? 'stub' : 'omit'
}

/** Shape sent to non-admins under the placeholder policy: no author, pseudonym or body. */
export const toStub = (message: any) => ({
  id: idOf(message._id ?? message.id),
  createdAt: message.createdAt,
  ...(message.parentMessage !== undefined &&
    message.parentMessage !== null && { parentMessage: idOf(message.parentMessage) }),
  hidden: true as const,
  body: null
})

/** Apply a view kind to an already-serialized message. Returns null for 'omit'. */
export function renderMessageView(serialized: any, kind: MessageViewKind): any | null {
  switch (kind) {
    case 'full':
      return serialized
    case 'flagged':
      return { ...serialized, hidden: true }
    case 'stub':
      return toStub(serialized)
    default:
      return null
  }
}

/**
 * Resolve every hidden message id in a conversation: directly hidden, authored by a hidden author,
 * or a (transitive) reply to either.
 */
export async function loadHideContext(
  conversationId: string | mongoose.Types.ObjectId,
  display: HiddenDisplay = hiddenDisplay
): Promise<HideContext> {
  const conversation: any = await Conversation.findById(conversationId).select('hiddenAuthors').lean()
  const authorIds: string[] = (conversation?.hiddenAuthors ?? []).map((a) => a.toString())
  const hiddenIds = new Set<string>()
  const seeds: any[] = await Message.find({
    conversation: conversationId,
    channels: HIDEABLE_CHANNEL,
    $or: [{ hiddenByAdmin: true }, ...(authorIds.length ? [{ owner: { $in: authorIds } }] : [])]
  })
    .select('_id')
    .lean()
  let frontier = seeds.map((m) => m._id.toString())
  frontier.forEach((id) => hiddenIds.add(id))
  while (frontier.length) {
    const replies: any[] = await Message.find({
      conversation: conversationId,
      channels: HIDEABLE_CHANNEL,
      parentMessage: { $in: frontier }
    })
      .select('_id')
      .lean()
    frontier = replies.map((m) => m._id.toString()).filter((id) => !hiddenIds.has(id))
    frontier.forEach((id) => hiddenIds.add(id))
  }
  return { hiddenAuthors: new Set(authorIds), hiddenIds, display }
}

/**
 * Whether a message is hidden from a model right now, judged against the database rather than a snapshot.
 * Work queued at post time (agent jobs) must call this before any LLM call: the message may have been hidden
 * (flagged, hidden author, reply to hidden) since it was enqueued. A message that cannot be found is not judged hidden.
 */
export async function isMessageHiddenFromModel(messageId: string | mongoose.Types.ObjectId): Promise<boolean> {
  const message: any = await Message.findById(messageId)
    .select('conversation channels owner parentMessage hiddenByAdmin')
    .lean()
  if (!message) return false
  const ctx = await loadHideContext(message.conversation)
  return isMessageHidden(message, ctx)
}

/**
 * Who a read is for. Every message read states one, so a new read site has to decide.
 *  - participant: what a non-admin viewer may see: hidden messages left out. A query cannot know the viewer, so an
 *                 author's own hidden messages are left out too; per-viewer reads use `viewMessageFor` instead
 *  - admin:       everything, hidden messages included (flagged by `viewMessageFor`)
 *  - model:       what an LLM may read. The same visibility as a participant: flagged, hidden-author and reply-to-hidden
 *                 messages are all excluded, whoever the reply is for.
 */
export type MessageAudience = 'participant' | 'admin' | 'model'

const matchFromContext = (ctx: HideContext): { _id?: { $nin: string[] } } =>
  ctx.hiddenIds.size ? { _id: { $nin: [...ctx.hiddenIds] } } : {}

/**
 * Mongo match for one audience: leaves hidden messages out for `participant` and `model`, nothing for `admin`.
 * For populated `messages` and direct queries; applies to the chat channel only (see `loadHideContext`).
 */
export async function hiddenMessagesMatch(
  conversationId: string | mongoose.Types.ObjectId,
  audience: MessageAudience
): Promise<{ _id?: { $nin: string[] } }> {
  if (audience === 'admin') return {}
  return matchFromContext(await loadHideContext(conversationId))
}

/* The hide context a populated message list was loaded under, keyed by the list itself. Lets
   getConversationHistory apply hidden authors and ids to `conversation.messages` without every agent
   passing the context through its history settings. */
const contextByList = new WeakMap<object, HideContext>()

/** The hide context `populateMessagesForModel` loaded a message list under, if it was loaded that way. */
export const hideContextOf = (messages: unknown): HideContext | undefined =>
  messages && typeof messages === 'object' ? contextByList.get(messages) : undefined

/**
 * Populate a conversation's `messages` for the model audience (hidden ones left out, plus `extraMatch`) and
 * remember the hide context used, so the history backstop can apply the same rules (see `hideContextOf`).
 * `extraPaths` are populated in the same call.
 */
export async function populateMessagesForModel(
  conversation: any,
  extraPaths: any[] = [],
  extraMatch: Record<string, unknown> = {}
): Promise<HideContext> {
  const ctx = await loadHideContext(conversation._id)
  await conversation.populate([{ path: 'messages', match: { ...extraMatch, ...matchFromContext(ctx) } }, ...extraPaths])
  if (conversation.messages) contextByList.set(conversation.messages, ctx)
  return ctx
}

export interface FindMessagesOptions {
  select?: string
  sort?: Record<string, 1 | -1>
  /** Plain objects instead of documents. */
  lean?: boolean
}

/**
 * The audience-aware read for one conversation's messages. Prefer this to a raw `Message.find`: the hidden-message
 * rules (flag, hidden author, reply cascade) are applied here in the query, not left to each caller.
 * `filter` is ANDed with the audience match, so it cannot widen it; `conversation` is always the one given.
 */
export async function findMessages(
  conversationId: string | mongoose.Types.ObjectId,
  audience: MessageAudience,
  filter: Record<string, unknown> = {},
  options: FindMessagesOptions = {}
): Promise<any[]> {
  const match = await hiddenMessagesMatch(conversationId, audience)
  let query: any = Message.find({ $and: [filter, { conversation: conversationId }, match] })
  if (options.select) query = query.select(options.select)
  if (options.sort) query = query.sort(options.sort)
  if (options.lean) return query.lean().exec()
  return query.exec()
}

/**
 * Widens a hide context with what can only be seen in an already-loaded message list: a message flagged
 * hidden, or one that replies (transitively) to a hidden one in the list. Lets a sync, in-memory reader apply
 * the same rules as the query side without a database round trip.
 */
export function expandHideContext(messages: any[], base: HideContext = emptyHideContext()): HideContext {
  const hiddenIds = new Set(base.hiddenIds)
  let grew = true
  while (grew) {
    grew = false
    for (const message of messages) {
      const self = idOf(message._id ?? message.id)
      if (self && !hiddenIds.has(self) && isMessageHidden(message, { ...base, hiddenIds })) {
        hiddenIds.add(self)
        grew = true
      }
    }
  }
  return { ...base, hiddenIds }
}

/** The messages an audience may read, from an already-loaded list. */
export function filterForAudience(messages: any[], audience: MessageAudience, ctx?: HideContext): any[] {
  if (audience === 'admin') return messages
  const expanded = expandHideContext(messages, ctx)
  return messages.filter((message) => !isMessageHidden(message, expanded))
}

/** Stable fingerprint of what was hidden in these conversations, so an output records the hidden set it was built under. */
export async function hiddenSetHash(conversationIds: Array<string | mongoose.Types.ObjectId>): Promise<string> {
  const parts: string[] = []
  for (const conversationId of conversationIds) {
    const ctx = await loadHideContext(conversationId)
    // a conversation with nothing hidden adds nothing, so a clean conversation joining a series does not change it
    if (ctx.hiddenAuthors.size === 0 && ctx.hiddenIds.size === 0) continue
    parts.push(`${conversationId}|${[...ctx.hiddenAuthors].sort().join(',')}|${[...ctx.hiddenIds].sort().join(',')}`)
  }
  return createHash('sha256').update(parts.sort().join('\n')).digest('hex')
}
