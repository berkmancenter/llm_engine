import Message from '../../models/message.model.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import logger from '../../config/logger.js'

// call with this specified for agent in question
// defaults to use instanceName as pseudonym
export default async function saveMessage(message, pseudonym?, broadcast = true) {
  const agentMessage = new Message(
    Object.assign(message, {
      fromAgent: true,
      conversation: this.conversation._id,
      pseudonym: pseudonym || this.instanceName,
      pseudonymId: this.pseudonyms[0]._id,
      owner: this._id
    })
  )

  await agentMessage.save()
  if (this.conversation.messages) {
    this.conversation.messages.push(agentMessage.toObject())
  }

  agentMessage.count = await this.conversation.messageCount()

  if (broadcast) {
    websocketGateway.broadcastNewMessage(agentMessage)
  }

  logger.debug(
    `Saved agent message: ${agentMessage._id} to conversation ${this.conversation._id} from ${agentMessage.pseudonym}`
  )
  return agentMessage
}
