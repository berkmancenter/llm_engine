import Conversation from '../models/conversation.model.js'
import websocketGateway from '../websockets/websocketGateway.js'

const addResources = async (newResources, conversationId) => {
  const conv = await Conversation.findByIdAndUpdate(
    conversationId,
    { $push: { resources: { $each: newResources } } },
    { new: true }
  )
    .select('resources')
    .exec()

  if (!conv) {
    throw new Error(`addResources: conversation ${conversationId} not found`)
  }

  websocketGateway.broadcastResourcesUpdated(conversationId, conv.resources as unknown[])
}

const resourceService = { addResources }
export default resourceService
