import agenda from './index.js'
import JobHandlers from './handlers/index.js'

const defineJob = {
  periodicAgent: async (agentId) => {
    await agenda.start()
    await agenda.define(`periodic - ${agentId}`, JobHandlers.periodicAgent)
  },
  agentResponse: async (agentId) => {
    await agenda.start()
    await agenda.define(`response - ${agentId}`, JobHandlers.agentResponse)
  },
  autoStartConversation: async () => {
    await agenda.start()
    await agenda.define('autoStart', JobHandlers.autoStartConversation)
  },
  autoStopConversation: async () => {
    await agenda.start()
    await agenda.define('autoStop', JobHandlers.autoStopConversation)
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
