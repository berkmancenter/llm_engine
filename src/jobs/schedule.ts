import agenda from './index.js'

const schedule = {
  periodicAgent: async (timerPeriod, data) => {
    await agenda.every(timerPeriod, `periodic - ${data.agentId}`, data, { skipImmediate: true })
  },
  agentResponse: async (data) => {
    await agenda.now(`response - ${data.agentId}`, data)
  },
  cancelPeriodicAgent: async (agentId) => {
    await agenda.cancel({ name: `periodic - ${agentId}` })
  },
  autoStartConversation: async (scheduledAt: Date, data) => {
    await agenda.schedule(scheduledAt, `autoStart - ${data.conversationId}`, data)
  },
  cancelAutoStartConversation: async (conversationId) => {
    await agenda.cancel({ name: `autoStart - ${conversationId}` })
  },
  autoStopConversation: async (scheduledAt: Date, data) => {
    await agenda.schedule(scheduledAt, `autoStop - ${data.conversationId}`, data)
  },
  cancelAutoStopConversation: async (conversationId) => {
    await agenda.cancel({ name: `autoStop - ${conversationId}` })
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
  },
  summarizePdf: async (data: { conversationId: string; resourceId: string; filePath: string; citation: string }) => {
    await agenda.now('summarize pdf', data)
  },
  pollExpired: async (expirationDate: Date, data: { pollId: string; conversationId: string }) => {
    await agenda.schedule(expirationDate, 'poll expired', data)
  },
  cancelPollExpired: async (pollId: string) => {
    await agenda.cancel({ name: 'poll expired', 'data.pollId': pollId })
  }
}

export default schedule
