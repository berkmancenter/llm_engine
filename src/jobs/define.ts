import agenda from './index.js'
import JobHandlers from './handlers/index.js'

const defineJob = {
  /* One definition per job TYPE, not per agent. agenda only ever processes a job name that
     some live process has define()'d (see jobs/CLAUDE.md and agent.service's boot-vs-
     reschedule note) - naming these per-agent would mean re-establishing the definition for
     every agent that has ever existed, on every boot, which is exactly the cost this was
     scoped to remove. The specific agent is carried in job data (data.agentId), matched via
     schedule.ts's unique() query, the same way conversationEvent/conversationCost/etc.
     already identify their target from data rather than from the job name. */
  periodicAgent: async () => {
    await agenda.start()
    await agenda.define('periodicAgent', JobHandlers.periodicAgent)
  },
  cronAgent: async () => {
    await agenda.start()
    await agenda.define('cronAgent', JobHandlers.periodicAgent)
  },
  agentResponse: async () => {
    await agenda.start()
    await agenda.define('agentResponse', JobHandlers.agentResponse)
  },
  autoStartConversation: async () => {
    await agenda.start()
    await agenda.define('autoStart', JobHandlers.autoStartConversation)
  },
  autoStopConversation: async (conversationId) => {
    await agenda.start()
    await agenda.define(`autoStop - ${conversationId}`, JobHandlers.autoStopConversation)
  },
  batchTranscript: async (conversationId) => {
    await agenda.start()
    await agenda.define(`batchTranscript - ${conversationId}`, JobHandlers.batchTranscript)
  },
  cleanUpTranscripts: async () => {
    await agenda.start()
    await agenda.define('clean up expired transcripts', JobHandlers.cleanUpTranscripts)
  },
  cleanUpTopics: async () => {
    await agenda.start()
    await agenda.define('clean up inactive topics', JobHandlers.cleanUpTopics)
  },
  summarizePdf: async () => {
    await agenda.start()
    await agenda.define('summarize pdf', JobHandlers.summarizePdf)
  },
  conversationEvent: async () => {
    await agenda.start()
    await agenda.define('conversationEvent', JobHandlers.conversationEvent)
  },
  conversationCost: async () => {
    await agenda.start()
    await agenda.define('conversationCost', JobHandlers.conversationCost)
  },
  conversationEndingSoon: async () => {
    await agenda.start()
    await agenda.define('conversationEndingSoon', JobHandlers.conversationEndingSoon)
  },
  pollExpired: async () => {
    await agenda.start()
    await agenda.define('poll expired', JobHandlers.pollExpired)
  }
}

export default defineJob
