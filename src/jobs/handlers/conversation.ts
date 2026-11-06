import logger from '../../config/logger.js'
import { Adapter, Conversation, Message } from '../../models/index.js'
import {
  doConversationEndingSoon,
  doStartConversation,
  doStopConversation
} from '../../services/conversation.service/lifecycle.js'
import adapterService from '../../services/adapter.service.js'
import agentService from '../../services/agent.service/index.js'
import agentDispatcher from '../agentDispatcher.js'
import schedule from '../schedule.js'
import { ConversationPhase } from '../../types/index.types.js'
import { AgentDocument } from '../../models/user.model/agent.model/index.js'
import isPreEventWindowOpen from '../../services/conversation.service/preEventWindow.js'

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

/* For adapter types that need to be live before the conversation officially starts — today
   just Zoom, whose Recall bot needs time to actually join the call before anything gets
   captured; see scheduleAdapterPreStart. Scoped to one adapterType per job so a future adapter
   type with the same need can reuse this without touching what Zoom's own schedule does.
   doStartConversation's own adapter loop will call adapterService.start on the same adapter
   again at scheduledTime; that's a safe no-op (e.g. Zoom's own isBotDeployed check). */
const preStartAdapter = async (job) => {
  const { conversationId, adapterType } = job.attrs.data as { conversationId: string; adapterType: string }
  try {
    const conversation = await Conversation.findOne({ _id: conversationId })
    if (!conversation) {
      logger.warn(`Adapter pre-start (${adapterType}): conversation ${conversationId} not found`)
      return
    }
    if (conversation.draft) {
      logger.debug(`Adapter pre-start (${adapterType}): conversation ${conversationId} is a draft, skipping`)
      return
    }
    if (conversation.active) {
      logger.debug(`Adapter pre-start (${adapterType}): conversation ${conversationId} already active, skipping`)
      return
    }
    const adapters = await Adapter.find({ conversation: conversationId, type: adapterType, active: false })
    // Isolated per adapter: one adapter failing to start (e.g. a uniqueness conflict) must not
    // block another adapter of the same type on this conversation from starting.
    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          await adapterService.start(adapter)
        } catch (err) {
          logger.error(`Adapter pre-start (${adapterType}): failed to start adapter ${adapter._id}`, err)
        }
      })
    )
  } catch (err) {
    logger.error(`Adapter pre-start (${adapterType}) failed for conversation ${conversationId}`, err)
  }
}

/* Shared by every conversation window (currently just preEvent — postEvent will reuse this
   same job/event once it has its own postEventMinutes field and a branch below; see
   ConversationPhase).

   preEvent fires well before doStartConversation ever runs. Agents that declare this phase in
   their capabilities' activeDuringPhases get started explicitly below (see that block for why
   this is an explicit opt-in rather than inferred from trigger shape); every other agent stays
   inactive until doStartConversation itself flips it.  */
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
    if (conversation.draft) {
      logger.debug(`Conversation window opened (preEvent): conversation ${conversationId} is a draft, skipping`)
      return
    }

    const preEventAgents = conversation.agents.filter(
      (agent) => agent.capabilities?.activeDuringPhases?.includes(phase) && !agent.active
    ) as unknown as AgentDocument[]
    // Isolated per agent: one agent's start() failing must not block the others from
    // activating, nor the dispatch below — a single broken agent shouldn't take the whole
    // window-open step down with it.
    await Promise.all(
      preEventAgents.map(async (agent) => {
        try {
          await agentService.startAgent(agent)
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
    await schedule.startConversationWindowCountdown({ conversationId: conversationIdStr, phase })
  } catch (err) {
    logger.error(`Conversation window opened (${phase}) failed for conversation ${conversationId}`, err)
  }
}

/* Recurring companion to openConversationWindow, started there once the window opens. Fires
   every minute so listeners (e.g. an agent waiting for "within a minute of scheduledTime")
   don't need their own periodic trigger running during preEvent

   Self-cancels once it no longer applies (conversation gone, unconfigured, or already started)
   rather than relying on any other call site to stop it — this job's own lifecycle is entirely
   self-contained. remainingMs/elapsedMs are recomputed fresh from the conversation's current
   scheduledTime/preEventMinutes on every tick, so an update made after the window already
   opened is picked up automatically, with no need to restart this job on every edit. */
const conversationWindowCountdown = async (job) => {
  const { conversationId, phase } = job.attrs.data as { conversationId: string; phase: ConversationPhase }
  try {
    // Only agent._id is used below (to notify agentDispatcher), so project agents down to just
    // that instead of hydrating full Agent documents on every tick of every open pre-event window.
    const conversation = await Conversation.findOne({ _id: conversationId }).populate('agents', '_id')
    // Same ObjectId-vs-string gotcha as openConversationWindow: re-derive from the fetched doc
    // when there is one, rather than trusting job.attrs.data's own type.
    const conversationIdStr = conversation?._id?.toString() ?? conversationId.toString()
    if (!conversation || phase !== 'preEvent' || !isPreEventWindowOpen(conversation)) {
      await schedule.cancelConversationWindowCountdown(conversationIdStr, phase)
      return
    }

    // isPreEventWindowOpen already guarantees both are set; the assertions just satisfy TS,
    // which can't narrow through an opaque function call.
    const scheduledTimeMs = conversation.scheduledTime!.getTime()
    const windowOpenedAtMs = scheduledTimeMs - conversation.preEventMinutes! * 60 * 1000
    const now = Date.now()

    const agentIds = conversation.agents.map((agent) => agent._id!.toString())
    await agentDispatcher.dispatch(
      {
        type: 'conversationWindowCountdown',
        conversationId: conversationIdStr,
        phase,
        elapsedMs: now - windowOpenedAtMs,
        remainingMs: scheduledTimeMs - now
      },
      { type: 'conversation', id: conversationIdStr },
      { alsoNotify: agentIds }
    )
  } catch (err) {
    logger.error(`Conversation window countdown (${phase}) failed for conversation ${conversationId}`, err)
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
  openConversationWindow,
  preStartAdapter,
  conversationWindowCountdown
}
export default conversationHandlers
