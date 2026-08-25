import agenda from './index.js'
import JobHandlers from './handlers/index.js'

/* Agenda's own default lockLifetime (10 min) assumes a job either finishes or dies within
   that window; once it elapses, the job's lock is treated as stale and another instance's
   poller will run it again from scratch. These jobs call out to an LLM (or, for
   batchTranscript, an embeddings API) and can legitimately run longer than 10 minutes under
   load, so they get a longer lockLifetime to avoid two instances genuinely running the same
   job concurrently. See jobs/handlers/* for the idempotency guards that cover the (much more
   likely) case of a job being killed and retried after its lock does expire. */
const LLM_JOB_LOCK_LIFETIME = 15 * 60 * 1000 // 15 minutes

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
    await agenda.define('cronAgent', JobHandlers.periodicAgent)
  },
  agentResponse: async () => {
    await agenda.define('agentResponse', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.agentResponse)
  },
  autoStartConversation: async () => {
    await agenda.define('autoStart', JobHandlers.autoStartConversation)
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
  summarizePdf: async () => {
    await agenda.define('summarize pdf', { lockLifetime: LLM_JOB_LOCK_LIFETIME }, JobHandlers.summarizePdf)
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
  }
}

export default defineJob
