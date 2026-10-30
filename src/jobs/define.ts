import agenda from './index.js'
import JobHandlers from './handlers/index.js'
import { LLM_JOB_LOCK_LIFETIME } from './lockLifetime.js'

const defineJob = {
  /* One definition per job TYPE, not per agent. agenda only ever processes a job name that
     some live process has define()'d (see jobs/CLAUDE.md and agent.service's boot-vs-
     reschedule note) - naming these per-agent would mean re-establishing the definition for
     every agent that has ever existed, on every boot, which is exactly the cost this was
     scoped to remove. The specific agent is carried in job data (data.agentId), matched via
     schedule.ts's unique() query, the same way conversationEvent/conversationCost/etc.
     already identify their target from data rather than from the job name. */
  periodicAgent: async () => {
    await agenda.define('periodicAgent', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.periodicAgent)
  },
  cronAgent: async () => {
    // Shares periodicAgent's handler and, now that Scorekeeper and Number Cruncher's cron
    // triggers both loop over conversations calling out to LangSmith, its LLM_JOB_LOCK_LIFETIME
    // too — this job name was missing it even though periodicAgent (same handler) already had it.
    await agenda.define('cronAgent', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.periodicAgent)
  },
  agentResponse: async () => {
    await agenda.define('agentResponse', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.agentResponse)
  },
  autoStartConversation: async () => {
    await agenda.define('autoStart', JobHandlers.autoStartConversation)
  },
  openConversationWindow: async () => {
    await agenda.define('openConversationWindow', JobHandlers.openConversationWindow)
  },
  autoStopConversation: async (conversationId) => {
    await agenda.define(
      `autoStop - ${conversationId}`,
      { lockLifetime: LLM_JOB_LOCK_LIFETIME },
      JobHandlers.autoStopConversation
    )
  },
  batchTranscript: async (conversationId) => {
    await agenda.define(
      `batchTranscript - ${conversationId}`,
      { lockLifetime: LLM_JOB_LOCK_LIFETIME },
      JobHandlers.batchTranscript
    )
  },
  cleanUpTranscripts: async () => {
    await agenda.define('clean up expired transcripts', JobHandlers.cleanUpTranscripts)
  },
  cleanUpTopics: async () => {
    await agenda.define('clean up inactive topics', JobHandlers.cleanUpTopics)
  },
  expireUnconfirmedConversations: async () => {
    await agenda.define('expire unconfirmed organizer confirmations', JobHandlers.expireUnconfirmedConversations)
  },
  summarizePdf: async () => {
    await agenda.define('summarize pdf', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.summarizePdf)
  },
  generateConceptGraph: async () => {
    await agenda.define('generateConceptGraph', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.generateConceptGraph)
  },
  conversationEvent: async () => {
    await agenda.define('conversationEvent', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.conversationEvent)
  },
  conversationCost: async () => {
    await agenda.define('conversationCost', JobHandlers.conversationCost)
  },
  conversationEndingSoon: async () => {
    await agenda.define('conversationEndingSoon', JobHandlers.conversationEndingSoon)
  },
  pollExpired: async () => {
    await agenda.define('poll expired', JobHandlers.pollExpired)
  },
  publicInviteResend: async () => {
    await agenda.define('publicInviteResend', JobHandlers.publicInviteResend)
  }
}

export default defineJob
