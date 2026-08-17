import { Worker } from 'node:cluster'
import socketIO from './socketIO.js'
import logger from '../config/logger.js'
import { getRoomIds } from './utils.js'

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
    await this.broadcast(conversation.topic._id.toString(), 'conversation:new', conversation)
  }

  async broadcastConversationUpdate(conversation) {
    if (!conversation.topic) return
    await this.broadcast(conversation.topic._id.toString(), 'conversation:update', conversation)
  }

  async broadcastConversationAlmostEnding(conversation) {
    await this.broadcast(conversation._id.toString(), 'conversation:ending', conversation)
  }

  async broadcastResourcesUpdated(conversationId: string, resources) {
    await this.broadcast(conversationId, 'resources:updated', { resources: resources.map((r) => r.toJSON()) })
  }

  /**
   * Broadcasts one incremental sentence of a still-generating agent answer, so a voice
   * client can start speaking before the full response finishes (see llmChain.ts's
   * streamAgentAndReportChunks). Ephemeral - never persisted as a Message, unlike
   * broadcastNewMessage - so it's safe to emit many times per request with no history/RAG
   * side effects. `done: true` marks the last chunk for a given requestId.
   */
  async broadcastAnswerChunk(
    conversationId: string,
    channels: string[],
    payload: { requestId: string; text: string; done: boolean }
  ) {
    await this.broadcast(conversationId, 'berky:answer_chunk', payload, channels)
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
