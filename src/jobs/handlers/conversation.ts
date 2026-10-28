import logger from '../../config/logger.js'
import { Conversation, Message } from '../../models/index.js'
import {
  doConversationEndingSoon,
  doStartConversation,
  doStopConversation
} from '../../services/conversation.service/lifecycle.js'
import agentDispatcher from '../agentDispatcher.js'
import { ConversationPhase } from '../../types/index.types.js'
import { AgentDocument } from '../../models/user.model/agent.model/index.js'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const MIN_TRANSCRIPT_MESSAGES_TO_STOP = 10
const NEVER_STARTED_GRACE_MS = 30 * 60 * 1000

const autoStartConversation = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`Auto-start: conversation ${conversationId} not found`)
      return
    }
    if (conversation.active) {
      logger.debug(`Auto-start: conversation ${conversationId} already active, skipping`)
      return
    }
    await conversation.populate(['topic', 'agents', 'adapters'])
    await doStartConversation(conversation)
  } catch (err) {
    logger.error(`Auto-start failed for conversation ${conversationId}`, err)
  }
}

/* Shared by every conversation window (currently just preEvent — postEvent will reuse this
   same job/event once it has its own postEventMinutes field and a branch below; see
   ConversationPhase).

   preEvent fires well before doStartConversation ever runs. perMessage-triggered agents get
   started explicitly below so they can handle pregame chat/DMs (see that block for why);
   every other agent (anything periodic/cron-only) stays inactive
   until doStartConversation itself flips it.  */
const openConversationWindow = async (job) => {
  const { conversationId, phase } = job.attrs.data as { conversationId: string; phase: ConversationPhase }
  try {
    const conversation = await Conversation.findOne({ _id: conversationId }).populate('agents')
    if (!conversation) {
      logger.warn(`Conversation window opened (${phase}): conversation ${conversationId} not found`)
      return
    }
    if (phase !== 'preEvent') {
      logger.warn(`Conversation window opened: phase "${phase}" is not yet implemented, skipping`)
      return
    }
    if (!conversation.preEventMinutes) {
      logger.debug(`Conversation window opened (preEvent): not configured for conversation ${conversationId}, skipping`)
      return
    }
    if (conversation.active || conversation.startTime) {
      logger.debug(`Conversation window opened (preEvent): conversation ${conversationId} already started, skipping`)
      return
    }

    /* Chat/DM responsiveness during preEvent needs agents actually `active`

       Deliberately agent.start() (the bare model method), not agentService.startAgent() — the
       service wrapper also schedules an agent's periodic/cron trigger if it has one, and
       eventAssistant's defaultTriggers has *both* perMessage and periodic (a 180s proactive
       check-in timer). Calling startAgent() here would start that timer running against an
       empty pregame chat, well before the event itself begins. */
    const perMessageAgents = conversation.agents.filter(
      (agent) => agent.triggers?.perMessage && !agent.active
    ) as unknown as AgentDocument[]
    // Isolated per agent: one agent's start() failing must not block the others from
    // activating, nor the dispatch below — a single broken agent shouldn't take the whole
    // window-open step down with it.
    await Promise.all(
      perMessageAgents.map(async (agent) => {
        try {
          await agent.start()
        } catch (err) {
          logger.error(`Conversation window opened (preEvent): failed to activate agent ${agent._id}`, err)
        }
      })
    )

    const conversationIdStr = conversation._id.toString()
    const agentIds = conversation.agents.map((agent) => agent._id!.toString())
    await agentDispatcher.dispatch(
      { type: 'conversationWindowOpened', conversationId: conversationIdStr, phase },
      { type: 'conversation', id: conversationIdStr },
      { alsoNotify: agentIds }
    )
  } catch (err) {
    logger.error(`Conversation window opened (${phase}) failed for conversation ${conversationId}`, err)
  }
}

const conversationEndingSoon = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`Conversation ending soon: conversation ${conversationId} not found`)
      return
    }
    if (!conversation.active) {
      logger.debug(`Conversation ending soon: conversation ${conversationId} already inactive, skipping`)
      return
    }
    await doConversationEndingSoon(conversation)
  } catch (err) {
    logger.error(`Conversation ending soon failed for conversation ${conversationId}`, err)
  }
}

const autoStopConversation = async (job) => {
  const { conversationId } = job.attrs.data
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`autoStop: conversation ${conversationId} not found`)
      return
    }
    if (!conversation.active) {
      logger.info(`autoStop: conversation ${conversationId} already inactive, skipping`)
      return
    }

    const now = Date.now()
    const [lastTranscriptMessage, transcriptCount] = await Promise.all([
      Message.findOne({ conversation: conversationId, channels: { $in: ['transcript'] } })
        .sort({ createdAt: -1 })
        .select('createdAt')
        .lean(),
      Message.countDocuments({ conversation: conversationId, channels: { $in: ['transcript'] } })
    ])

    const runningTimeMs = now - (conversation.startTime?.getTime() ?? now)
    const lastTranscriptMs = lastTranscriptMessage?.createdAt?.getTime() ?? 0
    const startTimeMs = conversation.startTime?.getTime() ?? 0
    const lastActivityMs = lastTranscriptMessage ? now - Math.max(lastTranscriptMs, startTimeMs) : Infinity

    if (lastActivityMs < IDLE_TIMEOUT_MS) {
      logger.debug(
        `autoStop: conversation ${conversationId} is active — last transcript ${
          lastActivityMs === Infinity ? 'never' : `${Math.round(lastActivityMs / 60000)} min ago`
        }, ${transcriptCount} message(s)`
      )
      return
    }

    // Never-started guard: few messages and within the grace period — give it more time
    if (transcriptCount < MIN_TRANSCRIPT_MESSAGES_TO_STOP && runningTimeMs < NEVER_STARTED_GRACE_MS) {
      logger.info(
        `autoStop: skipping stop for conversation ${conversationId} — only ${transcriptCount} transcript message(s), running for ${Math.round(
          runningTimeMs / 60000
        )} minutes`
      )
      return
    }

    const idleMinutes = lastActivityMs === Infinity ? 'never started' : `${Math.round(lastActivityMs / 60000)} min`
    logger.info(
      `autoStop: stopping conversation ${conversationId} — idle for ${idleMinutes}, ${transcriptCount} transcript message(s)`
    )
    await conversation.populate(['topic', 'agents', 'adapters'])
    await doStopConversation(conversation)
  } catch (err) {
    logger.error(`Auto stop check failed for conversation ${conversationId}`, err)
  }
}

const conversationHandlers = {
  autoStartConversation,
  autoStopConversation,
  conversationEndingSoon,
  openConversationWindow
}
export default conversationHandlers
