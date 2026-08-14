# Jobs (agenda) guide

Guidance for adding or changing anything scheduled through `agenda` in this folder. The app
runs on multiple autoscaled instances (see `infra/modules/webserver-mig`), and every instance
independently polls and processes jobs from the same `agendaJobs` collection — read this
before adding a new job so its state gets handled correctly under that.

## Why this is safe by default

Agenda's own per-job Mongo lock (`lockedAt` + `lockLifetime`) guarantees two instances never
run the *same due job document* concurrently — no leader election or app-level locking is
needed for that. `agenda.every()`/`agenda.schedule()` also upsert by job name, so every
instance calling `startJobs()` on boot is idempotent, not duplicative.

## What the lock does NOT protect against

If an instance is torn down mid-job (autoscaler scale-down, rolling deploy, health-check
restart — all routine under autoscaling, not rare) and the job's lock expires before it
finished, another instance will re-invoke the **entire handler from scratch**, with no memory
of how far the first attempt got — agenda has no checkpointing. This is a genuine, common
occurrence now, and it's on each handler to be safe to re-run wholesale, not on agenda.

## Checklist for any job with an external side effect

If a job calls an LLM, sends an email, calls an adapter/external API, or writes to the vector
store — anything that would be wrong to do twice — work through this before writing it:

1. **Claim before you act, not after.** If the affected document has a natural "done" state
   (`conversation.active`, `topic.isArchiveNotified`, `resource.summary`), flip and persist it
   *before* the side effect, not after. See `doStartConversation`/`doStopConversation` in
   `../services/conversation.service/lifecycle.ts`, `emailUsersToArchive` in
   `../services/topic.service.ts`, and `summarizePdf` in `../services/resource.service.ts`.
2. **No natural flag, but a stable trigger id exists** (a specific message, a one-time event)?
   Use `Agent.claimResponseTrigger(triggerId)` (`../models/user.model/agent.model/index.ts`) —
   an atomic, `$ne`-guarded update — before calling the LLM. See `agentResponse` and
   `conversationEvent` in `handlers/`.
3. **Recurring job, no natural per-tick id** (agenda reuses one job document across every
   `every()` recurrence, so there's no "this tick" identity to claim)? Debounce against
   existing state instead — see the proactive-agent branch of `periodicAgent` in
   `handlers/agent.ts`.
4. **Set `lockLifetime` above the job's realistic worst case** in `define.ts` if it calls an
   LLM or embeddings API. The 10-minute library default can be shorter than a real call under
   load, which would let another instance start the same job as a genuine *concurrent*
   duplicate — not just a retry. `LLM_JOB_LOCK_LIFETIME` (15 min) in that file is the existing
   convention; add new LLM-calling job names to it rather than inventing a new constant.
5. **No clean idempotency key exists?** Accept the gap explicitly with a comment (see
   `batchTranscript` in `handlers/transcript.ts`, which duplicates RAG chunks on a retry and
   says so) rather than shipping it silently — silence reads as "handled" to the next person
   who touches the file.

## Graceful shutdown

`src/index.ts`'s `SIGTERM` handler calls `drainAgenda()` (`gracefulShutdown.ts`), which is
`agenda.drain()` — deliberately not `agenda.stop()`. `stop()` clears the lock on jobs still
*running* on this instance immediately, which would let another instance start the same job
while this one is still executing it. `drain()` waits for in-flight jobs to actually finish
first (bounded by a timeout, so a hung job can't block shutdown forever). This is a latency
optimization for the common successful-deploy path, not the safety mechanism — safety comes
entirely from #4 above: an ungracefully killed instance behaves the same either way, since the
lock just sits until `lockLifetime` expires regardless of how the process went down.

## Tests

Idempotency guards and the plumbing above are exercised in `tests/jobs/handlers/`,
`tests/models/agent.model.test.ts` (`claimResponseTrigger`), and `tests/unit/jobs/`
(`agendaConfig`, `define`, `startup`, `gracefulShutdown`). Add a new job to that pattern rather
than starting a new one.
