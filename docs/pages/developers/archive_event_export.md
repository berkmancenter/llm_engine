# Completed-event archive export

The engine can queue completed public event summaries for curator review in the
BKC Archive Wiki. Export is independent of community assistants, chat notification
settings and post-event analytics. No chat messages or raw transcripts are sent.

## Product requirements

Completed public `eventAssistant` and `backChannel` conversations with saved
summaries qualify. Active, draft, locked, membership-restricted events, missing or
private/deleted topics, and empty summaries do not. Check eligibility at delivery,
including retries. This release covers completed events, not calendar listings.

Use a stable `(source=llm-engine, source_id=conversationId)` for every request.
The receiving API must atomically deduplicate and preserve curator edits and
review decisions. Delivery creates a private draft; public event eligibility is
not automatic publication approval. A curator approves/rejects the draft in the
wiki before it enters the source corpus and entity synthesis. The paired wiki
PRD is `docs/event-ingestion-prd.md` in `berkmancenter/bkc-archive-wiki`.

Agenda stores job data (`conversationId`, `attempts`, `status`, `reason`, `path`).
Each event has one logical queue identity. Its API identity also protects against
multiple job documents caused by concurrent scheduling or acknowledgment loss.
Retries recheck eligibility and use 1/2/4/8/16 minute backoff, up to six attempts.
Network failures, 429 and 5xx retry; other HTTP failures are terminal. The handler
persists attempts before delivery, and the API owns the final idempotency claim.
No response bodies, bearer tokens or summary text are included in delivery logs.

## Configuration and release order

Deploy the paired archive API change **first**. Its event POST must accept stable
`source_id`, return the same draft path on repeat delivery, and preserve review
receipts. Existing URL configuration alone never enabled event export.

Set on the engine runtime (not just GitHub Actions):

```text
BKC_ARCHIVE_API_URL=https://<archive-api-host>
BKC_ARCHIVE_API_TOKEN=<shared token>
BKC_ARCHIVE_EXPORT_ENABLED=true
```

The archive service uses `ARCHIVE_API_TOKEN` for the same shared token. The export
switch defaults to false so existing deployments remain unchanged until the
paired API is ready. Existing archive read/search tools are unaffected.

After deploying the engine with the flag enabled, a newly stopped event with a
saved summary queues an `archiveEvent` job. Its worker logs one of:

```text
Archive export queued event=<id>
Archive export skipped event=<id> reason=<code>
Archive export retry event=<id> attempt=<n> reason=<code>
Archive export delivered event=<id> path=inbox/conversations/event-<hash>.md
Archive export failed event=<id> attempts=<n> reason=<code>
```

The old `Filed "..." to the archive inbox` log belongs to the unmerged historical
branch. Use the ID-based messages above for this implementation.

## Verify one event and backfill

On a trusted engine host, inspect eligible completed records without enqueueing:

```sh
NODE_ENV=production node dist/scripts/backfillArchiveEvents.js --limit=25
NODE_ENV=production node dist/scripts/backfillArchiveEvents.js --id=<conversation-id>
```

The default is dry-run. To queue a selected event or bounded batch:

```sh
NODE_ENV=production node dist/scripts/backfillArchiveEvents.js --id=<conversation-id> --enqueue
NODE_ENV=production node dist/scripts/backfillArchiveEvents.js --limit=25 --enqueue
```

Use `--retry --enqueue` after fixing a terminal failure or intentionally
reconsidering a skipped record. Delivered jobs are never reset. The command lists
only IDs and eligibility codes, not summaries or names. It does not launch a
worker; the running engine processes the persisted jobs. The bounded batch scans
most recent matching completed events; use explicit IDs for older records.

A process failure between summary persistence and queue creation can leave a
completed event without a job; this backfill command is also the recovery path.
It does not regenerate missing summaries or automatically recover past events.

For acceptance, select one real eligible public event, queue it, find its delivered
log/status, and confirm exactly one matching file under the archive service's
persistent inbox. Run the enqueue command twice and verify that no extra draft
appears. Test API reachability/auth from the engine host, not just a developer's
laptop. Keep the inbox private; never use a real private event as a public smoke test.

On the archive host, a curator can inspect/edit the draft and use
`python3 scripts/review_event.py approve ... --reviewer ... --source-url ...`.
Approval creates a source item and event page, builds the item stub, and adds
requested links to existing people/topics. Submit reviewed content in a wiki PR.
A public source URL and any recording URLs are provided during review; the engine
does not guess a frontend URL or expose an internal recording location.

The API VM's existing daily git pull/reindex updates content only. An API code
release needs `npm ci`, `npm run build` and a service restart. Preserve the inbox
and review receipts; never clean them during deployment. Site publishing remains
separate and is intentionally outside this change.

## Acceptance tests

- Pure policy/HTTP tests: public eligibility, source identity, field allowlist,
  authenticated POST, duplicate acknowledgment, retryable and terminal failures.
- Worker tests: persisted outcomes, bounded retries, privacy changes before retry,
  disabled export and rerunning delivered work.
- Mongo/Agenda tests: deduplication, completion preserving scheduled retry, explicit
  retry of terminal work and unchanged delivered records.
- Paired API tests: one draft for concurrent requests, authentication, safe metadata,
  no inbox exposure through page traversal, review decisions and exact builder links.
- Cross-repository HTTP test uses this engine's compiled delivery client against
  the real archive API app with synthetic content and a temporary inbox.
