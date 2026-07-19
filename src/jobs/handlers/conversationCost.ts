import logger from '../../config/logger.js'
import Conversation from '../../models/conversation.model.js'
import Agent from '../../models/user.model/agent.model/index.js'
import conversationCostTrackingService from '../../services/conversationCostTracking.service.js'

/* Runs unconditionally for every stopped conversation (see doStopConversation),
   independent of Number Cruncher being provisioned — cost tracking must not depend
   on a separately-provisioned Slack bot existing. If an active Number Cruncher agent
   IS present, it already runs this same flow itself (via agentDispatcher ->
   onConversationEvent) so it can also post a Slack cost card; running it again here
   would duplicate the LangSmith settle-poll and the persisted record, so this job
   steps aside in that case. */
const conversationCost = async (job) => {
  const { conversationId, topicIsPrivate } = job.attrs.data
  try {
    const activeNumberCruncher = await Agent.findOne({ agentType: 'numberCruncher', active: true }).exec()
    if (activeNumberCruncher) {
      logger.debug(
        `conversationCost job: an active Number Cruncher agent will handle cost tracking for conversation ` +
          `${conversationId}; skipping the standalone run to avoid a duplicate settle-poll`
      )
      return
    }

    const conversation = await Conversation.findById(conversationId).exec()
    if (!conversation) {
      logger.warn(`conversationCost job: could not find conversation ${conversationId}`)
      return
    }

    logger.info(
      `conversationCost job: no active Number Cruncher agent found; tracking cost directly for conversation ${conversationId}`
    )
    await conversationCostTrackingService.trackConversationCost(conversation, { topicIsPrivate })
  } catch (error) {
    logger.error(`conversationCost job failed for conversation ${conversationId}`, error)
  }
}

export default { conversationCost }
