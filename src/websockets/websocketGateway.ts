import { Worker } from 'node:cluster'
import socketIO from './socketIO.js'
import logger from '../config/logger.js'
import { getRoomIds, getRoomId, getAdminRoomId } from './utils.js'
import serializeMessage, { ownerIdOf } from '../utils/serializeMessage.js'
import { ArtifactVersionNotice } from '../types/index.types.js'
import {
  HideContext,
  HiddenDisplay,
  loadHideContext,
  renderMessageView,
  viewMessageFor,
  viewerOf
} from '../utils/messageVisibility.js'

const isSubdocument = (value) => value !== null && typeof value === 'object' && value.constructor === Object

/* An unpopulated path holds ObjectIds, and destructuring one replaces the id with its internal
   buffer, so leave anything that is not already a plain object alone. */
const redactEach = (entries, redact) => entries.map((entry) => (isSubdocument(entry) ? redact(entry) : entry))

/**
 * Strip credentials out of a conversation before it goes into a topic room. Joining a topic room
 * takes no authorization, so this has to match what findByIdFull hands a non-owner.
 * @param conversation - a Conversation document or an already-plain object
 * @returns {Object} a plain object safe to emit
 */
function redactConversationForBroadcast(conversation) {
  const { channels, agents, adapters, ...rest } =
    typeof conversation.toJSON === 'function' ? conversation.toJSON() : conversation

  return {
    ...rest,
    ...(channels && {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      channels: redactEach(channels, ({ passcode, ...channel }) => channel)
    }),
    ...(agents && {
      agents: redactEach(agents, ({ agentConfig, ...agent }) => {
        // Clients need the bot's name to label the chat, so it is the one key that survives.
        const botName = agentConfig?.botName
        return typeof botName === 'string' && botName !== '' ? { ...agent, agentConfig: { botName } } : agent
      })
    }),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    ...(adapters && { adapters: redactEach(adapters, ({ config, ...adapter }) => adapter) })
  }
}

class WebsocketGateway {
  public _worker: Worker | null

  constructor() {
    this._worker = null
  }

  set worker(workerInstance) {
    this._worker = workerInstance
  }

  /**
   * @param channels - channel rooms to emit to; omit for the bare conversation room, `[]` for none
   * @param extraRooms - further room ids emitted to in the same call (the admin room, a user's own room)
   */
  async broadcast(conversation, eventName, data, channels?, extraRooms?: string[]) {
    if (this._worker) {
      // We are on the master node. This will use a worker node to emit the message
      this._worker.send({
        conversation,
        event: eventName,
        message: data,
        channels,
        extraRooms
      })
    } else {
      // Not on master, can use socketIO directly
      const roomIds = getRoomIds(conversation, channels)
      socketIO.getConnection().emitMultiple(extraRooms?.length ? [roomIds, ...extraRooms].flat() : roomIds, eventName, data)
    }
  }

  /**
   * Revoke a user's admin-room membership everywhere. Call it when their role may have lost the right to moderate:
   * the admin room is joined once from the role at join time and never re-validated, so without this a demoted
   * admin's open sockets would keep receiving hidden message bodies until they disconnected.
   */
  async evictFromAdminRooms(userId: string) {
    if (this._worker) {
      this._worker.send({ evictAdminRoomsFor: userId })
    } else {
      await socketIO.getConnection()?.evictFromAdminRooms(userId)
    }
  }

  /**
   * Hidden messages are split by audience instead of sent to the shared channel rooms:
   * admins get it flagged in the admin room, the author gets it unflagged in their own user room,
   * everyone else gets nothing (or a stub under the placeholder policy). See messageVisibility.ts.
   */
  async broadcastNewMessage(message, request: string | null = null, hideContext?: HideContext) {
    logger.debug(
      'Creating message %s via socket for userId %s, conversation %s, channels %s. Message text = "%s"',
      request,
      message.owner,
      message.conversation._id.toString(),
      message.channels.join(),
      message.body
    )

    const conversationId = message.conversation._id.toString()
    const ctx = hideContext ?? (await loadHideContext(conversationId))
    const payload = {
      ...serializeMessage(message),
      count: message.count,
      request,
      pause: message.pause
    }
    const sharedView = viewMessageFor(message, { isAdmin: false }, ctx)
    if (sharedView === 'full') {
      await this.broadcast(conversationId, 'message:new', payload, message.channels)
      return
    }

    // Hidden: nothing reaches the shared rooms unless the policy sends a stub.
    if (sharedView === 'stub') {
      await this.broadcast(conversationId, 'message:new', renderMessageView(payload, 'stub'), message.channels)
    }
    await this.broadcast(
      conversationId,
      'message:new',
      renderMessageView(payload, 'flagged'),
      [],
      [getAdminRoomId(conversationId)]
    )
    const ownerId = ownerIdOf(message.owner)
    if (ownerId && viewMessageFor(message, viewerOf({ _id: ownerId }), ctx) === 'full') {
      await this.broadcast(conversationId, 'message:new', payload, [], [ownerId])
    }
  }

  /**
   * Ids only, never bodies. Hiding goes to the conversation's rooms (bare room plus the channel rooms
   * the messages were in); unhiding goes to the admin room only, because everyone else gets the
   * restored messages through the normal `message:new` path.
   */
  async broadcastMessagesHidden(
    conversationId: string,
    payload: { messageIds: string[]; hidden: boolean; display: HiddenDisplay },
    channels: string[] = []
  ) {
    if (payload.hidden) {
      await this.broadcast(
        conversationId,
        'message:hidden',
        payload,
        channels.length ? channels : undefined,
        channels.length ? [getRoomId(conversationId)] : undefined
      )
      return
    }
    await this.broadcast(conversationId, 'message:hidden', payload, [], [getAdminRoomId(conversationId)])
  }

  /** Toast trigger for the hidden author, sent to their own user room. */
  async broadcastHiddenNotice(
    conversationId: string,
    userId: string,
    payload: { conversationId: string; scope: 'message' | 'user'; messageIds: string[] }
  ) {
    await this.broadcast(conversationId, 'message:hidden-notice', payload, [], [userId])
  }

  async broadcastNewPoll(poll) {
    await this.broadcast(poll.conversation._id.toString(), 'poll:new', poll)
  }

  async broadcastNewPollChoice(conversationId, pollResponse) {
    await this.broadcast(conversationId, 'choice:new', pollResponse)
  }

  async broadcastPollThreshold(conversationId: string, pollId: string) {
    await this.broadcast(conversationId, 'poll:threshold', { pollId })
  }

  async broadcastPollExpired(conversationId: string, pollId: string) {
    await this.broadcast(conversationId, 'poll:expired', { pollId })
  }

  async broadcastNewVote(message) {
    const conversationId = message.conversation._id.toString()
    const ctx = await loadHideContext(conversationId)
    const sharedView = viewMessageFor(message, { isAdmin: false }, ctx)
    if (sharedView === 'full') {
      await this.broadcast(conversationId, 'vote:new', message, message.channels)
      return
    }
    // A vote on a hidden message must not carry its body to the shared rooms.
    const serialized = typeof message.toJSON === 'function' ? serializeMessage(message) : message
    if (sharedView === 'stub') {
      await this.broadcast(conversationId, 'vote:new', renderMessageView(serialized, 'stub'), message.channels)
    }
    await this.broadcast(
      conversationId,
      'vote:new',
      renderMessageView(serialized, 'flagged'),
      [],
      [getAdminRoomId(conversationId)]
    )
  }

  async broadcastNewConversation(conversation) {
    // A topicless draft (e.g. from an unmatched inbound invite) has no topic room to broadcast into.
    if (!conversation.topic) return
    await this.broadcast(conversation.topic._id.toString(), 'conversation:new', redactConversationForBroadcast(conversation))
  }

  async broadcastConversationUpdate(conversation) {
    if (!conversation.topic) return
    await this.broadcast(
      conversation.topic._id.toString(),
      'conversation:update',
      redactConversationForBroadcast(conversation)
    )
  }

  async broadcastConversationStarted(conversation) {
    await this.broadcast(conversation._id.toString(), 'conversation:started', {
      conversationId: conversation._id.toString()
    })
  }

  async broadcastConversationStopped(conversation) {
    await this.broadcast(conversation._id.toString(), 'conversation:stopped', {
      conversationId: conversation._id.toString()
    })
  }

  async broadcastConversationAlmostEnding(conversation) {
    await this.broadcast(conversation._id.toString(), 'conversation:ending', { conversationId: conversation._id.toString() })
  }

  async broadcastResourcesUpdated(conversationId: string, resources) {
    await this.broadcast(conversationId, 'resources:updated', { resources: resources.map((r) => r.toJSON()) })
  }

  /**
   * Tells clients a new version exists so they can refetch it over HTTP. Only ids go out:
   * the conversation room is joined without any passcode, while reading an artifact needs
   * the artifact passcode, so the content must come from the route that checks it.
   *
   * The container is named because Socket.io does not tell a client which room an event
   * arrived through, and a client that has moved between conversations may still be in the
   * old room. `conversationId` is present only for a conversation-scoped artifact.
   */
  async broadcastArtifactVersion(conversationId: string, notice: ArtifactVersionNotice) {
    await this.broadcast(conversationId, 'artifact:version', notice)
  }

  /**
   * Broadcasts one incremental sentence of a still-generating message so a
   * client can start displaying before the full response finishes. Ephemeral — never
   * persisted as a Message. `done: true` marks the final chunk for a given requestId.
   */
  async broadcastMessageChunk(
    conversationId: string,
    channels: string[],
    payload: { requestId: string; text: string; done: boolean }
  ) {
    await this.broadcast(conversationId, 'message:chunk', payload, channels)
  }

  async broadcastTranscriptStatusChange(conversation, status) {
    await this.broadcast(
      conversation._id.toString(),
      'transcript:status',
      {
        conversationId: conversation._id.toString(),
        status
      },
      ['transcript']
    )
  }
}
const websocketGateway = new WebsocketGateway()
export default websocketGateway
