import agenda from '../../../src/jobs/index.js'
import defineJob from '../../../src/jobs/define.js'

const LLM_JOB_LOCK_LIFETIME = 15 * 60 * 1000 // 15 minutes, see jobs/define.ts

/* Agenda's own default lockLifetime (10 min) assumes a job either finishes or dies within
   that window. Jobs that call out to an LLM or an embeddings API can legitimately run
   longer than that under load, so they get a longer lockLifetime — otherwise a slow-but-
   still-running job's lock would look stale to another instance's poller, which would then
   run the exact same job a second time (genuine concurrent double-execution, not just a
   retry). These tests guard that every LLM-calling job actually got the override, and that
   jobs with no such call were deliberately left at the default. */
describe('job definitions set lockLifetime based on whether the job calls an LLM/embeddings API', () => {
  test('periodicAgent, agentResponse, and batchTranscript get the extended lockLifetime', async () => {
    await defineJob.periodicAgent('agent-1')
    await defineJob.agentResponse('agent-1')
    await defineJob.batchTranscript('conversation-1')

    expect(agenda._definitions['periodic - agent-1'].lockLifetime).toBe(LLM_JOB_LOCK_LIFETIME)
    expect(agenda._definitions['response - agent-1'].lockLifetime).toBe(LLM_JOB_LOCK_LIFETIME)
    expect(agenda._definitions['batchTranscript - conversation-1'].lockLifetime).toBe(LLM_JOB_LOCK_LIFETIME)
  })

  test('autoStop, summarizePdf, and conversationEvent get the extended lockLifetime', async () => {
    await defineJob.autoStopConversation('conversation-1')
    await defineJob.summarizePdf()
    await defineJob.conversationEvent()

    expect(agenda._definitions['autoStop - conversation-1'].lockLifetime).toBe(LLM_JOB_LOCK_LIFETIME)
    expect(agenda._definitions['summarize pdf'].lockLifetime).toBe(LLM_JOB_LOCK_LIFETIME)
    expect(agenda._definitions.conversationEvent.lockLifetime).toBe(LLM_JOB_LOCK_LIFETIME)
  })

  test('jobs with no external LLM/embeddings call keep the default lockLifetime', async () => {
    await defineJob.autoStartConversation()
    await defineJob.cleanUpTranscripts()
    await defineJob.cleanUpTopics()
    await defineJob.conversationCost()
    await defineJob.conversationEndingSoon()
    await defineJob.pollExpired()

    const defaultLockLifetime = agenda._defaultLockLifetime
    expect(agenda._definitions.autoStart.lockLifetime).toBe(defaultLockLifetime)
    expect(agenda._definitions['clean up expired transcripts'].lockLifetime).toBe(defaultLockLifetime)
    expect(agenda._definitions['clean up inactive topics'].lockLifetime).toBe(defaultLockLifetime)
    expect(agenda._definitions.conversationCost.lockLifetime).toBe(defaultLockLifetime)
    expect(agenda._definitions.conversationEndingSoon.lockLifetime).toBe(defaultLockLifetime)
    expect(agenda._definitions['poll expired'].lockLifetime).toBe(defaultLockLifetime)
  })
})
