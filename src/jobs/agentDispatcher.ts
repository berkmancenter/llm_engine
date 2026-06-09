import Agent from '../models/user.model/agent.model/index.js'
import access from '../auth/access.js'
import schedule from './schedule.js'
import logger from '../config/logger.js'
import { ConversationEvent, ReadScope } from '../types/index.types.js'

async function dispatch(event: ConversationEvent, scope: ReadScope) {
  const candidates = await Agent.find({ active: true }).populate('conversation').exec()

  let notified = 0
  for (const agent of candidates) {
    try {
      access.assertCanRead(agent, scope)
      const agentId = agent._id.toString()
      await schedule.conversationEvent({ agentId, event })
      notified++
    } catch (err) {
      logger.debug(`Agent ${agent._id} skipped: ${err.message}`)
    }
  }

  if (notified > 0) {
    logger.debug(`Dispatched ${event.type} to ${notified} agent(s) for ${scope.type} ${scope.id}`)
  }
}

export default { dispatch }
