import Agent from '../models/user.model/agent.model/index.js'
import access from '../auth/access.js'
import schedule from './schedule.js'
import logger from '../config/logger.js'
import { ConversationEvent, ReadScope } from '../types/index.types.js'

/**
 * Schedules a conversationEvent job for every agent allowed to read the event's scope.
 *
 * @param alsoNotify Agents to include even though they are no longer active: the stop
 *   routine switches off a conversation's own agents before it announces the stop.
 */
async function dispatch(event: ConversationEvent, scope: ReadScope, { alsoNotify = [] }: { alsoNotify?: string[] } = {}) {
  const filter = alsoNotify.length > 0 ? { $or: [{ active: true }, { _id: { $in: alsoNotify } }] } : { active: true }
  const candidates = (await Agent.find(filter).populate('conversation').exec()).filter((agent) =>
    agent.handlesConversationEvents()
  )

  let notified = 0
  for (const agent of candidates) {
    try {
      access.assertCanRead(agent, scope)
      const agentId = agent._id.toString()
      await schedule.conversationEvent({ agentId, event })
      notified++
    } catch (err) {
      logger.warn(`Agent ${agent._id} skipped: ${err.message}`)
    }
  }

  if (notified > 0) {
    logger.debug(`Dispatched ${event.type} to ${notified} agent(s) for ${scope.type} ${scope.id}`)
  }
}

export default { dispatch }
