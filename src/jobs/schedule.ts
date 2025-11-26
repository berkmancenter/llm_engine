import agenda from './index.js'

const schedule = {
  periodicAgent: async (timerPeriod, data) => {
    await agenda.every(timerPeriod, `periodic - ${data.agentId}`, data, { skipImmediate: true })
  },
  agentResponse: async (data) => {
    await agenda.now(`response - ${data.agentId}`, data)
  },
  agentIntroduction: async (data) => {
    await agenda.now(`introduction - ${data.agentId}`, data)
  },
  cancelPeriodicAgent: async (agentId) => {
    await agenda.cancel({ name: `periodic - ${agentId}` })
  },
  batchTranscript: async (timerPeriod, data) => {
    await agenda.every(timerPeriod, `batchTranscript - ${data.conversationId}`, data, { skipImmediate: true })
  },
  cancelBatchTranscript: async (conversationId) => {
    await agenda.cancel({ name: `batchTranscript - ${conversationId}` })
  },
  cleanUpTranscripts: async () => {
    await agenda.every('0 2 * * *', 'clean up expired transcripts')
  },
  cleanUpTopics: async () => {
    await agenda.every('0 1 * * *', 'clean up inactive topics')
  }
}

export default schedule
