import logger from '../../config/logger.js'
import Agent from '../../models/user.model/agent.model/index.js'
import messageService, { agentResponseToMessageData } from '../../services/message.service.js'
import { AgentResponseZodSchema } from '../../types/index.types.js'

const conversationEvent = async (job) => {
  const { agentId, event } = job.attrs.data
  try {
    const agent = await Agent.findOne({ _id: agentId }).exec()
    if (!agent) {
      logger.warn(`Could not find agent ${agentId}`)
      return
    }
    logger.debug(`conversationEvent handler ${agent._id} - event type: ${event.type}`)
    const responses = await agent.onConversationEvent(event)
    for (const response of responses) {
      const parsed = AgentResponseZodSchema.safeParse(response)
      if (!parsed.success) {
        logger.error(`conversationEvent handler ${agent._id} - invalid response shape, skipping`, parsed.error)
        continue
      }
      await messageService.newMessageHandler(agentResponseToMessageData(response, agent), agent)
    }
  } catch (error) {
    logger.error(`conversationEvent job failed for agent ${agentId}`, error)
  }
}

export default { conversationEvent }
