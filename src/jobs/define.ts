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
  agentIntroduction: async (agentId) => {
    await agenda.start()
    await agenda.define(`introduction - ${agentId}`, JobHandlers.agentIntroduction)
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
  }
}

export default defineJob
