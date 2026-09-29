# Handoff: system-wide LLM cost savings, remaining levers

Self-contained status doc — read this first. It tells you what shipped, what's verified, and
exactly what to do next. It does not repeat the reasoning or the numbers; that's all in
`docs/investigations/llm-cost-savings-survey.md` (referenced by section below).

- **Branch/PR:** `worktree-prompt-caching` → [PR #340](https://github.com/berkmancenter/llm_engine/pull/340)
  (open, targets `main`). This PR also carries the earlier `eventAssistant` prompt-caching
  work — see `docs/investigations/prompt-caching-bedrock-handoff.md` for that piece.
- **Full investigation notes:** `docs/investigations/llm-cost-savings-survey.md` — read its
  "Bottom line" and §5 before doing anything below.
- **This doc's status:** the two items below are shipped and pushed. Everything under
  "What's next" is not started.

## TL;DR

Two agents (`moderatorNotifier`, `proactiveGroupAgent`) fire on a fixed 120s clock for every
live event regardless of activity, and together are ~33% of attributed production LLM cost.
Real production data (LangSmith call cadence + a read-only prod Mongo query) grounded two
low-risk activity gates, which are now shipped. Real data also *revised the expected savings
down* from earlier reasoning-without-data — this is a correct, safe change, not a big win on
its own. The larger, still-open levers (caching, deduplicating redundant work, a system-wide
model-choice question) are unstarted.

## What shipped (commits `a1059416`, `8f33128f`)

| File | Change |
|---|---|
| `src/agents/moderatorNotifier/moderatorNotifier.ts` | `evaluate()` now rejects when no message with `fromAgent: false` arrived within the last `timerPeriod` (120s) — narrows the framework's existing (coarser, "any message in any channel including other agents'") activity gate. |
| `src/agents/proactiveGroupAgent/proactiveGroupAgent.ts` | `evaluate()` now implements a three-way gate: run on chat activity; skip entirely when chat and transcript are both quiet; when chat alone is quiet, skip entirely unless a silence-compatible goal (`provoke_participation`/`play_commentary`/`poll_reveal`/`missing_perspective`) is eligible for the conversation. `getTraceMetadata()` now includes `activeGoalIds`. |
| `tests/unit/agents/moderatorNotifier/moderatorNotifier.evaluate.test.ts` | New — 5 cases covering the participant-activity gate. |
| `tests/unit/agents/proactiveGroupAgent/proactiveGroupAgent.evaluate.test.ts` | New — 7 cases covering all branches of the three-way gate. |
| `scripts/experiments/scratchCadenceAnalysis.ts` | Kept per this PR's "keep experiment scripts for reference" convention — the per-conversation call-cadence query that grounded both changes. |
| `docs/investigations/llm-cost-savings-survey.md` | Corrected (moderatorNotifier *does* have an existing framework gate — an earlier draft said it didn't) and re-grounded in real data throughout §4.1/§4.2/§5. |

**Explicitly not done as part of shipping the gates above** (see §5 items 3-7 of the survey
doc for full reasoning on each):

1. **Backoff for one remaining sub-case.** `proactiveGroupAgent`'s "chat quiet, transcript
   active, silence-compatible goal eligible" case still runs at full 120s cadence — a real
   backoff needs either an external Agenda reschedule call (`timerPeriod` is baked into the
   job at schedule time, not re-read per tick) or new persisted state (a schema field like
   `lastActiveMessageCount`), both bigger changes than the gates above.
2. **Deduplicating the two agents' per-tick fetch.** `moderatorNotifier` and
   `proactiveGroupAgent` independently fetch and RAG-search nearly the same
   chat/DM/transcript content every 120s tick.
3. **Extending `CACHE_BREAKPOINT_MARKER`** (shipped for `eventAssistant` in the earlier part
   of this PR) to these two agents — their prompts (37-85K avg tokens) are well clear of any
   model's cache-eligibility minimum, unlike `eventAssistant`'s.
4. **Incremental caching for `librarian`'s tool loop** — its ~4-calls-per-turn agentic loop
   resends a guaranteed-byte-identical growing prefix each call, the cleanest caching case in
   the codebase.
5. **The model-choice question at system scope** — Opus 4.6 is 93.7% of *all* production LLM
   calls, not just `eventAssistant`'s. Needs LangSmith eval verification and budget approval
   before any default changes (same gate as the caching doc's own model-choice item, §6.5).

## Verification performed

- `yarn lint` / `yarn prettier` / `yarn build`: clean (5 pre-existing warnings, none in
  touched files — same baseline as the rest of this PR).
- Unit tests for the two changed files, run directly (not via `yarn test` — see note below):
  `NODE_ENV=test node --experimental-vm-modules ./node_modules/.bin/jest -i --forceExit
  tests/unit/agents/moderatorNotifier tests/unit/agents/proactiveGroupAgent` — **32/32 pass**
  (3 suites: the two new files plus the pre-existing `proactiveGroupAgent.respond.test.ts`,
  confirmed unaffected).
  - Gotcha hit while verifying: a bare `npx jest` invocation (without
    `--experimental-vm-modules`) fails with a misleading transform error, and without
    `--forceExit` the process hangs silently after tests actually finish (Mongo/agenda
    handles don't close cleanly — documented in `tests/CLAUDE.md`, easy to mistake for a
    real hang). Use the exact command above, not a shortened one.
- **Not run:** the full `yarn test` / `yarn test:agents` suites. Run before merging.
- **Not measurable yet:** the real production hit rate of either shipped gate. A `REJECT`
  from `evaluate()` never reaches `respond()`, so there's no LangSmith trace for a skipped
  tick — this is structural, not a gap to fix. The `logger.debug` skip-reason lines added in
  this change (`"no recent participant activity"`, `"chat and transcript both quiet"`,
  `"no silence-compatible goal eligible"`) are how to see this in production logs after
  deploy.

## Real-data grounding already done (don't re-derive this)

Gathered this session via LangSmith aggregate queries and one read-only production Mongo
query (via `llm_engine-infra`'s `scripts/llm-engine-prod-run.sh --mongo-eval` — aggregate
counts/metadata only, never message bodies):

- Existing activity gates suppress only ~7% of ticks within a conversation's active span
  (fan-out events with hundreds of concurrent DM channels almost always have *something*
  change within any 120s window).
- Only ~10.4% of 10-minute windows are genuinely both-chat-and-transcript-quiet (8/77
  buckets, 6 real conversations) — the real ceiling for that branch.
- 84% of real conversations with goals configured already have a silence-compatible goal
  enabled, from an apparently uniform platform default (every sample had the *identical*
  14-goal list) — the goal-aware full-skip branch will rarely fire under current
  configuration.
- 16-47% of messages (avg ~28%) are `fromAgent: true` — supports the participant-only
  narrowing for `moderatorNotifier`, though its precise skip-conversion effect wasn't
  isolated separately.

Full detail, methodology, and caveats: survey doc §1, §4.1, §4.2.

## Immediate next steps, in order

1. **Review and merge this PR** (or split the gating change into its own PR if preferred —
   it's independent of the `eventAssistant` caching work already in this branch).
2. **Deploy and grep production logs** for the three new skip-reason debug lines to get the
   real hit rate before building anything further — this is cheap and should happen before
   step 3.
3. **Decide whether the backoff follow-up (item 1 above) is worth building**, using real data
   from step 2 rather than the reasoned estimate in the survey doc.
4. **Pick up the larger levers** (items 2-4 above) — none are blocked on each other or on the
   model-choice item; do in whatever order makes sense.
5. **The model-choice item (item 5)** — needs the LangSmith eval comparison from the caching
   doc's §6.5/handoff doc, which was never run (explicitly deferred, costs real inference
   money, needs budget approval). This is the same open item as the caching handoff doc's
   step 4 — one decision, not two.

## Environment note for whoever picks this up

This work happened in a git worktree at `.claude/worktrees/prompt-caching` (branch
`worktree-prompt-caching`, tracking `origin/worktree-prompt-caching`). If that worktree
was removed at session end, recreate it with:

```bash
git fetch origin worktree-prompt-caching
git worktree add .claude/worktrees/prompt-caching worktree-prompt-caching
cd .claude/worktrees/prompt-caching && yarn install
```

`node_modules` and `.env` are gitignored and won't come with a fresh worktree — copy `.env`
from the main checkout (or reconstruct from `.env.example`) before running anything that
needs `MONGODB_URL`/`LANGSMITH_API_KEY`.
