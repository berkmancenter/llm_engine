import agenda from './index.js'

const schedule = {
  /* periodicAgent/cronAgent share one job name across every agent (see define.ts), so the
     recurring-schedule identity has to come from data.agentId rather than from the name.
     agenda.every() can't express that: its upsert key is {name, type:'single'} with no data
     in it at all, so two agents sharing a name would collide into one document. unique()
     upserts on {name, ...query} instead - agenda.create()'s default type is 'normal', which
     routes save() through that path instead of the type:'single' one. This still needs the
     same skipImmediate + $set-on-every-save behavior every() gave us, so callers keep relying
     on the same reschedule-vs-recovery guard (see agent.service's "Boot vs. reschedule" note)
     to decide *whether* to call this at all - it does not itself protect an existing
     nextRunAt the way agenda's type:'single' path partially does. */
  periodicAgent: async (timerPeriod, data) => {
    const job = agenda.create('periodicAgent', data)
    job.unique({ 'data.agentId': data.agentId })
    job.repeatEvery(timerPeriod, { skipImmediate: true })
    await job.save()
  },
  agentResponse: async (data) => {
    await agenda.now('agentResponse', data)
  },
  cancelPeriodicAgent: async (agentId) => {
    await agenda.cancel({ name: 'periodicAgent', 'data.agentId': agentId })
  },
  /* Existence checks so callers can tell "this agent already has a live schedule in the
     shared job collection" from "this agent needs one". Kept here rather than in the
     caller so the job-name format stays owned by this file. */
  periodicAgentExists: async (agentId) => (await agenda.jobs({ name: 'periodicAgent', 'data.agentId': agentId })).length > 0,
  cronAgentExists: async (agentId) => (await agenda.jobs({ name: 'cronAgent', 'data.agentId': agentId })).length > 0,
  cronAgent: async (expression: string, data) => {
    const job = agenda.create('cronAgent', data)
    job.unique({ 'data.agentId': data.agentId })
    job.repeatEvery(expression, { skipImmediate: true })
    await job.save()
  },
  cancelCronAgent: async (agentId) => {
    await agenda.cancel({ name: 'cronAgent', 'data.agentId': agentId })
  },
  autoStartConversation: async (scheduledAt: Date, data) => {
    await agenda.schedule(scheduledAt, 'autoStart', data)
  },
  cancelAutoStartConversation: async (conversationId) => {
    await agenda.cancel({ name: 'autoStart', 'data.conversationId': conversationId })
  },
  autoStopConversation: async (timerPeriod, data, firstRunAt: Date) => {
    const job = agenda.create(`autoStop - ${data.conversationId}`, data)
    job.repeatEvery(timerPeriod)
    job.schedule(firstRunAt)
    await job.save()
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
  conversationEvent: async (data: { agentId: string; event: unknown }) => {
    await agenda.now('conversationEvent', data)
  },
  conversationCost: async (data: { conversationId: string; topicIsPrivate: boolean }) => {
    await agenda.now('conversationCost', data)
  },
  conversationEndingSoon: async (scheduledAt: Date, data: { conversationId: string }) => {
    await agenda.schedule(scheduledAt, 'conversationEndingSoon', data)
  },
  cancelConversationEndingSoon: async (conversationId) => {
    await agenda.cancel({ name: 'conversationEndingSoon', 'data.conversationId': conversationId })
  },
  pollExpired: async (expirationDate: Date, data: { pollId: string; conversationId: string }) => {
    await agenda.schedule(expirationDate, 'poll expired', data)
  },
  cancelPollExpired: async (pollId: string) => {
    await agenda.cancel({ name: 'poll expired', 'data.pollId': pollId })
  }
}

export default schedule
