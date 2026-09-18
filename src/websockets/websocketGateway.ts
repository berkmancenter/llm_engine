import { Worker } from 'node:cluster'
import socketIO from './socketIO.js'
import logger from '../config/logger.js'
import { getRoomIds } from './utils.js'
import { ArtifactVersionNotice } from '../types/index.types.js'

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

  async broadcast(conversation, eventName, data, channels?) {
    if (this._worker) {
      // We are on the master node. This will use a worker node to emit the message
      this._worker.send({
        conversation,
        event: eventName,
        message: data,
        channels
      })
    } else {
      // Not on master, can use socketIO directly
      const roomIds = getRoomIds(conversation, channels)
      socketIO.getConnection().emitMultiple(roomIds, eventName, data)
    }
  }

  async broadcastNewMessage(message, request = null) {
    logger.debug(
      'Creating message %s via socket for userId %s, conversation %s, channels %s. Message text = "%s"',
      request,
      message.owner,
      message.conversation._id.toString(),
      message.channels.join(),
      message.body
    )

    await this.broadcast(
      message.conversation._id.toString(),
      'message:new',
      {
        ...message.toJSON(),
        count: message.count,
        request,
        pause: message.pause
      },
      message.channels
    )
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
    await this.broadcast(message.conversation._id.toString(), 'vote:new', message, message.channels)
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

  async broadcastConversationAlmostEnding(conversation) {
    await this.broadcast(conversation._id.toString(), 'conversation:ending', conversation)
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
