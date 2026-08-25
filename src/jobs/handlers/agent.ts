import logger from '../../config/logger.js'
import Agent from '../../models/user.model/agent.model/index.js'
import messageService, { agentResponseToMessageData } from '../../services/message.service.js'
import resourceService from '../../services/resource.service.js'
import { AgentMessageActions, AgentResponseZodSchema } from '../../types/index.types.js'

const handleAgentResponse = async (response, agent) => {
  const parsed = AgentResponseZodSchema.safeParse(response)
  if (!parsed.success) {
    logger.error(`agentResponse handler ${agent._id} - invalid response shape, skipping`, parsed.error)
    return
  }
  return messageService.newMessageHandler(agentResponseToMessageData(response, agent), agent)
}

const agentResponse = async (job) => {
  const { agentId, message } = job.attrs.data
  try {
    const agent = await Agent.findOne({ _id: agentId }).exec()
    if (!agent) {
      logger.warn(`Could not find agent ${agentId}`)
      return
    }

    // respond() populates conversation.messages/channels itself on every call, so only the
    // conversation ref needs loading here.
    await agent.populate('conversation')

    logger.debug(`agentResponse handler ${agent._id} - ${agent.conversation._id!.toString()}`)

    const responses = await agent.respond(message)
    for (const response of responses) {
      if (response.messageType === 'resources') {
        await resourceService.addResources(response.message, agent.conversation._id!.toString())
      } else {
        await handleAgentResponse(response, agent)
      }
    }
  } catch (error) {
    logger.error(`Response failed for agent ${agentId}`, error)
  }
}
const periodicAgent = async (job) => {
  const { agentId } = job.attrs.data
  logger.debug(`Agenda activation ${agentId}`)
  const agent = await Agent.findOne({ _id: agentId }).exec()
  if (!agent) {
    logger.warn(`Could not find agent ${agentId}`)
    return
  }

  // evaluate() and respond() each populate conversation.messages/channels themselves on every
  // call, so only the conversation ref needs loading here.
  await agent.populate('conversation')
  logger.debug(`periodicAgent handler ${agent._id} - ${agent.conversation._id!.toString()}`)

  const agentEvaluation = await agent.evaluate()
  if (agentEvaluation.action === AgentMessageActions.CONTRIBUTE) {
    const responses = await agent.respond()
    for (const response of responses) {
      if (response.messageType === 'resources') {
        await resourceService.addResources(response.message, agent.conversation._id!.toString())
      } else {
        await handleAgentResponse(response, agent)
      }
    }
  }
}
const agentHandlers = {
  agentResponse,
  periodicAgent
}
export default agentHandlers
