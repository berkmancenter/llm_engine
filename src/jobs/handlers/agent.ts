import logger from '../../config/logger.js'
import Agent from '../../models/user.model/agent.model/index.js'
import messageService from '../../services/message.service.js'
import { AgentMessageActions } from '../../types/index.types.js'

const agentResponse = async (job) => {
  const { agentId, message } = job.attrs.data
  try {
    const agent = await Agent.findOne({ _id: agentId }).exec()
    if (!agent) {
      logger.warn(`Could not find agent ${agentId}`)
      return
    }

    await agent.populate({
      path: 'conversation',
      populate: [{ path: 'messages' }, { path: 'channels' }]
    })

    logger.debug(`agentResponse handler ${agent._id} - ${agent.conversation._id!.toString()}`)

    const responses = await agent.respond(message)
    for (const response of responses) {
      await messageService.newMessageHandler(response, agent)
    }
  } catch (error) {
    logger.error(`Response failed for agent ${agentId}`, error)
  }
}
const agentIntroduction = async (job) => {
  const { agentId, channelId } = job.attrs.data
  try {
    const agent = await Agent.findOne({ _id: agentId }).exec()
    if (!agent) {
      logger.warn(`Could not find agent ${agentId}`)
      return
    }

    await agent.populate({
      path: 'conversation',
      populate: [{ path: 'channels' }]
    })

    logger.debug(` agentIntroduction handler ${agent._id} - ${agent.conversation._id!.toString()}`)

    const channel = agent.conversation.channels.find((c) => c._id!.toString() === channelId.toString())
    if (!channel) {
      throw new Error(`Channel ${channelId} not found on agent conversation`)
    }
    const introductions = await agent.introduce(channel)
    for (const introduction of introductions) {
      await messageService.newMessageHandler(introduction, agent)
    }
  } catch (error) {
    logger.error(`Introduction failed for agent ${agentId}`, error)
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

  await agent.populate({
    path: 'conversation',
    populate: [{ path: 'messages' }, { path: 'channels' }]
  })
  logger.debug(`periodicAgent handler ${agent._id} - ${agent.conversation._id!.toString()}`)

  const agentEvaluation = await agent.evaluate()
  if (agentEvaluation.action === AgentMessageActions.CONTRIBUTE) {
    const responses = await agent.respond()
    for (const response of responses) {
      await messageService.newMessageHandler(response, agent)
    }
  }
}
const agentHandlers = {
  agentResponse,
  agentIntroduction,
  periodicAgent
}
export default agentHandlers
