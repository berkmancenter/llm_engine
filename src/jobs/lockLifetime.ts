/* Agenda's own default lockLifetime (10 min) assumes a job either finishes or dies within
   that window; once it elapses, the job's lock is treated as stale and another instance's
   poller will run it again from scratch. These jobs call out to an LLM (or, for
   batchTranscript, an embeddings API) and can legitimately run longer than 10 minutes under
   load, so they get a longer lockLifetime to avoid two instances genuinely running the same
   job concurrently. See jobs/handlers/* for the idempotency guards that cover the (much more
   likely) case of a job being killed and retried after its lock does expire. */
export const LLM_JOB_LOCK_LIFETIME = 15 * 60 * 1000 // 15 minutes
export default LLM_JOB_LOCK_LIFETIME
