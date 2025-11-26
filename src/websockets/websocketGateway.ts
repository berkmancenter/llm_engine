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
    await this.broadcast(poll.topic._id.toString(), 'poll:new', poll)
  }

  async broadcastNewPollChoice(topicId, pollResponse) {
    await this.broadcast(topicId, 'choice:new', pollResponse)
  }

  async broadcastNewVote(message) {
    await this.broadcast(message.conversation._id.toString(), 'vote:new', message, message.channels)
  }

  async broadcastNewConversation(conversation) {
    await this.broadcast(conversation.topic._id.toString(), 'conversation:new', conversation)
  }

  async broadcastConversationUpdate(conversation) {
    await this.broadcast(conversation.topic._id.toString(), 'conversation:update', conversation)
  }
}
const websocketGateway = new WebsocketGateway()
export default websocketGateway
