import logger from '../../config/logger.js'
import Agent from '../../models/user.model/agent.model/index.js'
import Message from '../../models/message.model.js'
import messageService, { agentResponseToMessageData } from '../../services/message.service.js'
import resourceService from '../../services/resource.service.js'
import schedule from '../schedule.js'
import { AgentMessageActions, AgentResponseZodSchema } from '../../types/index.types.js'

/* Proactive periodic agents have no natural per-tick trigger id to claim (agenda reuses one
   job document for every recurrence of an `every()` job, and each tick is a legitimate new
   contribution, not a repeat of the last one) — so they can't use claimResponseTrigger the
   way agentResponse/conversationEvent do. Instead, debounce: skip if this agent already
   posted in the conversation more recently than this. A retry after a mid-job kill happens
   within agenda's lockLifetime, which is far shorter than any sane periodic interval, so this
   catches the retry case without ever suppressing a legitimate tick. */
const PROACTIVE_RESPONSE_DEBOUNCE_MS = 30_000

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

    // Trigger-less calls (agentService.startAgent) all share one key per conversation, since
    // they only ever fire once, at conversation start.
    const triggerId = message?._id ? `message:${message._id}` : `start:${agent.conversation._id}`
    if (!(await agent.claimResponseTrigger(triggerId))) {
      logger.debug(`agentResponse handler ${agent._id} - trigger ${triggerId} already handled, skipping`)
      return
    }

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
  /* Both cases below mean this recurring schedule has outlived the agent it was created for
     (deleted, or stopped) — normally schedulePeriodicAgent's/stopAgent's cancel calls remove
     it at that point, but if that cancel was ever missed (a partial failure mid-cleanup, a
     doc deleted without going through the service), the schedule keeps firing this handler
     on every tick forever. `agent.evaluate()` itself returns undefined for an inactive agent
     (see Agent.evaluate's `if (!this.active) return`), which would otherwise throw reading
     `.action` off it below. Since a job document is shared by every recurrence, cancelling it
     here self-heals any already-orphaned schedule instead of repeating the failure forever;
     cancelling both names is harmless when the other doesn't match. */
  if (!agent || !agent.active) {
    logger.warn(`${agent ? 'Found inactive' : 'Could not find'} agent ${agentId}; cancelling orphaned ${job.attrs.name} schedule`)
    await schedule.cancelPeriodicAgent(agentId)
    await schedule.cancelCronAgent(agentId)
    return
  }

  // evaluate() and respond() each populate conversation.messages/channels themselves on every
  // call, so only the conversation ref needs loading here.
  await agent.populate('conversation')
  logger.debug(`periodicAgent handler ${agent._id} - ${agent.conversation._id!.toString()}`)

  const agentEvaluation = await agent.evaluate()
  if (agentEvaluation.action === AgentMessageActions.CONTRIBUTE) {
    if (agent.triggers?.periodic?.proactive) {
      const lastOwnMessage = await Message.findOne({ conversation: agent.conversation._id, owner: agent._id })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean()
      const sinceLastMessage = lastOwnMessage?.createdAt ? Date.now() - lastOwnMessage.createdAt.getTime() : Infinity
      if (sinceLastMessage < PROACTIVE_RESPONSE_DEBOUNCE_MS) {
        logger.debug(`periodicAgent handler ${agent._id} - responded ${sinceLastMessage}ms ago, skipping`)
        return
      }
    }
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
