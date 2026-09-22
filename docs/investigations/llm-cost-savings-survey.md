# System-wide LLM cost survey — beyond `eventAssistant` caching

- **Status:** The two activity gates below (moderatorNotifier, proactiveGroupAgent) are
  **shipped** as part of this PR. Everything else in this document — the caching extension,
  the fetch dedup, librarian caching, the model-choice item — is investigation only, not
  implemented. Follow-on to the caching work in `docs/investigations/prompt-caching-bedrock.md`
  (see that doc for the caching mechanism itself, and for the Opus 4.6 → Opus 5 model-choice
  analysis — this doc doesn't repeat either).
- **Scope:** Where does the other ~45% of production LLM cost go (everything outside
  `eventAssistant`'s tool path), and what — beyond caching — is actually driving it.
- **Cost:** $0. Read-only aggregate queries against LangSmith (`getRunStats`/`listRuns`) and
  a read-only production Mongo query (via `llm_engine-infra`'s `llm-engine-prod-run.sh
  --mongo-eval`), plus static code reading. No live inference calls, no writes anywhere.

## Bottom line

**Two periodic agents — `proactiveGroupAgent` and `moderatorNotifier` — run on a fixed
120-second clock for the full duration of every live event, regardless of whether anything
new happened, and together are ~33% of attributed production cost.** Neither is caching-blocked
the way `eventAssistant` is (their prompts are 15–85K tokens on average — far above any model's
cache minimum). `moderatorNotifier` does already have a framework-level gate (an earlier draft
of this doc said it didn't — corrected in §4.1), but it's coarser than it looks.

**Important correction from an earlier draft of this doc:** a blanket "skip when nothing new
happened" gate is safe for `moderatorNotifier` but is **wrong** for `proactiveGroupAgent` — four
of its eleven group-chat goals (`provoke_participation`, `play_commentary`, `poll_reveal`,
`missing_perspective`) exist specifically to fire *because* chat has gone quiet, or don't need
chat at all. Gating on chat silence unconditionally would disable part of the agent's core
value, not just its cost. See §4.2 for the goal-aware gate that avoids this.

**Shipped, low-risk levers that don't require a model decision or eval verification** (real
numbers, not reasoned estimates — gathered from LangSmith cadence data and a read-only
production Mongo query this session; see §4.1/§4.2/§5 for the full grounding and why the
expected impact is more modest than earlier reasoning suggested):

1. **`moderatorNotifier.evaluate()` now rejects when no *participant* message (not
   agent-authored) arrived within the last tick period** (§4.1) — narrows the existing
   framework gate, which real data shows only suppresses ~7% of ticks on its own.
2. **`proactiveGroupAgent.evaluate()` now uses a three-way, goal-aware gate** (§4.2): run on
   chat activity; skip entirely when chat and transcript are both quiet (real ceiling: ~10.4%
   of 10-minute windows); when chat alone is quiet, skip entirely unless a silence-compatible
   goal is eligible (real data: 84% of conversations already have one, from an apparently
   uniform platform default — so this specific branch rarely fires *today*).

**Not shipped — larger, separate levers still worth pursuing** (§5, items 3-7): a backoff for
the one sub-case #2 doesn't fully address; deduplicating the two agents' near-identical
per-tick RAG/context fetch; extending `CACHE_BREAKPOINT_MARKER` to both agents; incremental
caching for `librarian`'s tool loop; re-surfacing the model-choice item at system scope. These
remain the better-substantiated wins in this document — the shipped gates are correct and
safe, but real data revised their expected size down, not up.

---

## 1. Data source and a caveat worth reading before trusting any dollar figure here

Real production telemetry, pulled from the `llmEngine` LangSmith project (this is the
project actually used by the deployed app — not the `brendan` project, which is a personal
dev/eval project and had ~0 relevant traffic; see `scripts/experiments/scratchListLangsmithProjects.ts`).

**Coverage gap, found and only partially explained:** three independent query methods —
`getRunStats` with `filter` on `isRoot`, `getRunStats` with `traceFilter` on `runType: 'llm'`,
and a 9×7-day chunked sum of the second method — all converge exactly on **$1,286.01 /
236,426,698 prompt tokens** attributed to the 17 known agent-type trace-root names (§2).
The project's true unfiltered 60-day total is **$2,410.66 / 435,590,514 prompt tokens**
(§2) — meaning **~46.7% of cost / ~45.7% of prompt tokens is not attributed to any named
agent type**.

What's ruled out: a missing/unknown agent name. Every root-trace name found in every clean
sample (a full 24h enumeration, a full 7-day enumeration, and the per-agent breakdown itself)
was already in the known list from `src/agents/index.ts`. A 7-day window's per-agent sum
reconciles exactly against that same window's unfiltered total — the gap only appears at
60-day scale.

What's not ruled out: the gap is likely concentrated in one or more historical high-volume
weeks (an older week, days 28–35 back, had 3,000+ root runs in under 7 days — more than the
most recent full week's 2,109 — consistent with a large live event). An attempt to get that
week's per-name breakdown timed out (`scripts/experiments/scratchLangsmithRootNamesRange.ts`)
before finishing. **This wasn't chased further** — the instruction driving this survey was
explicitly not to block on it, and every clean sample available points at the same agent-type
concentration story, just potentially understating it.

**Practical read: treat the per-agent percentages in §2 as directionally reliable (the same
concentration pattern held at every window size tested), and the absolute dollar figures as a
real but incomplete ~53% slice** — if anything the true weight of `proactiveGroupAgent` /
`moderatorNotifier` is understated here, not overstated, since the missing volume is most
plausibly clustered in old high-traffic event-days that would have exercised these two
periodic agents hardest.

---

## 2. Headline numbers (60 days, `llmEngine` project, unfiltered)

| Metric | Value |
|---|---:|
| Agent turns (root runs) | 25,336 |
| LLM calls | 37,824 |
| Total tokens | 445,209,640 |
| Prompt tokens | 435,590,514 (**97.8%** of all tokens) |
| Completion tokens | 9,619,126 |
| Total cost | **$2,410.66** |
| Prompt cost | $2,171.98 (**90.1%** of total cost) |
| Completion cost | $238.68 |
| Prompt tokens, p50 / p99 | 4,231 / 124,286 |
| Cost per LLM call, p50 / p99 | $0.025 / $0.60 |
| Error rate | 2.99% |
| **Cache activity** | **`prompt_token_details.cache_read` / `.cache_creation`: `null` project-wide** — zero caching is active anywhere in production, consistent with the caching PR not yet being merged |

**Model concentration** (7-day sample, 4,425 LLM calls — `scripts/experiments/scratchLangsmithModelNames.ts`):

| Model | Share of calls |
|---|---:|
| `claude-opus-4-6` | 93.7% |
| `claude-haiku-4-5-20251001` | 3.7% |
| `claude-sonnet-4-6` | 1.4% |
| `claude-opus-5` | 1.1% (small live canary) |

Opus 4.6 dominates system-wide, not just for `eventAssistant` — the caching doc's §6
model-choice analysis (Opus 4.6 → Opus 5 as a near-free win, pending eval verification)
applies to the system's dominant cost driver overall, not one agent.

---

## 3. Per-agent breakdown (attributed slice — see §1's caveat)

Methodology: `client.getRunStats({ runType: 'llm', traceFilter: 'eq(name, "<agentType>")' })`,
summed across 9 overlapping 7-day chunks spanning 60 days
(`scripts/experiments/scratchLangsmithChunkedBreakdown.ts`).

| Agent | LLM calls | Prompt tokens | Cost | Share of attributed cost | Avg prompt tok/call | Cadence |
|---|---:|---:|---:|---:|---:|---|
| `eventAssistant` | 5,574 | 124,631,832 | $703.43 | 54.7% | 22,359 | per-message + periodic |
| `proactiveGroupAgent` | 648 | 43,788,164 | $225.94 | 17.6% | 67,574 | **every 120s, unconditional** |
| `moderatorNotifier` | 440 | 37,677,480 | $195.18 | 15.2% | 85,631 | **every 120s, unconditional** |
| `librarian` | 535 (≈4/turn) | 20,243,881 | $105.63 | 8.2% | 37,839 | every 15min, gated |
| `communityAssistant` | 305 | 6,793,979 | $35.57 | 2.8% | 22,275 | per-message |
| `RunnableSequence` | 2,019 | 1,669,121 | $10.05 | 0.8% | 827 | (classification/chain calls) |
| `jargonFilterAgent` | 439 | 890,773 | $7.98 | 0.6% | 2,029 | per-message |
| `vibesAnalyst` | 48 | 153,820 | $1.18 | 0.1% | 3,205 | post-event |
| `conversationSummary` | 26 | 480,565 | $0.54 | 0.0% | 18,483 | post-event |
| `voiceAssistant` | 21 | 97,083 | $0.50 | 0.0% | 4,623 | per-message |
| `scorekeeper`, `numberCruncher`, `backChannelInsights`, `chatbot`, `eventSetup`, `backChannelMetrics`, `conceptCartographer` | — | 0 | $0.00 | 0.0% | — | procedural / non-LLM |

`eventAssistant` is the agent the shipped caching PR covers. **Everything below it in the
table has no caching, and the next two rows — `proactiveGroupAgent` and `moderatorNotifier` —
are 32.8% of attributed cost combined**, more than `eventAssistant`'s per-call average despite
far fewer calls, because their prompts are 3–4× larger per call.

---

## 4. What the code actually does (why these two agents cost what they do)

### 4.1 `moderatorNotifier` — fully static system prompt, a coarser activity gate than it looks

**Correction from an earlier draft of this doc:** this agent is *not* ungated. The
framework's own `evaluate()` (`src/models/user.model/agent.model/index.ts:296-300`) already
skips the whole turn — before any fetch, before `respond()` — when the conversation's total
message count hasn't changed since this agent's last activation, for any periodic trigger
that isn't marked `proactive: true` (this one isn't). The earlier claim that there's "no check
anywhere" was wrong.

What's true instead: that count includes messages from *every* channel and *every other
agent* in the conversation, not just the transcript/chat/DM content this agent actually
reasons about. Real production cadence data (60 sampled conversations' worth of LangSmith
call timestamps) shows this coarse gate only suppresses **~7% of ticks** within a
conversation's active span — because fan-out events (hundreds of concurrent DM channels,
§4.4) almost always have *something* change somewhere within any 120s window, even when the
signal this agent actually cares about is quiet. A read-only production Mongo query
(6 real conversations) found **16-47% of messages are `fromAgent: true`** — real, if
imprecisely quantified, support for tightening the check to participant activity only.

`src/agents/moderatorNotifier/moderatorNotifier.ts`:

- `SYSTEM_PROMPT` (lines 11–54) is **byte-for-byte static** — zero interpolation. A textbook
  `cache_control` candidate, and unlike `eventAssistant`'s ~1,850-token stable prefix, this
  agent's prompts average 85,631 tokens — nowhere near any model's cache-eligibility floor.
- `defaultTriggers.periodic.timerPeriod: 120` (line 111) — fires every 2 minutes for the
  entire event. When the framework's coarse gate above doesn't skip it, every tick
  unconditionally: re-fetches the transcript (`transcript.getTranscript`, 600s window),
  re-runs a RAG search over it (`transcript.searchTranscript`), re-fetches and reformats up
  to 100 shared-chat messages and 100 direct-message-channel messages (across *every* DM
  channel in the conversation), then calls the LLM.
- `USER_TEMPLATE` (lines 56–76) interpolates `previousAlerts`, `recentTranscript`,
  `retrievedChunks`, `privateMessages`, `sharedChatHistory` — all rebuilt from scratch each
  tick, all volatile by construction even when the underlying data barely changed between
  consecutive 120-second windows.

**Shipped in this PR:** `evaluate()` now also rejects when no message in the conversation
within the last `timerPeriod` seconds has `fromAgent: false` — narrowing the framework's
"did the conversation change" check to "did a participant do something," on top of the
existing gate rather than replacing it.

### 4.2 `proactiveGroupAgent` — stable system prompt, but "skip when nothing new" is the wrong gate here

`src/agents/proactiveGroupAgent/proactiveGroupAgent.ts`:

- The system prompt is `composeSystemPrompt(getProactiveGroupSystemPrompt(goals), {
  conversationContext, behaviorPolicy, goals, channelType, personalityName, goalPriorities,
  goalContext })` (line 182, built in `src/agents/helpers/promptComposer.ts:301–334`). Every
  input to that composition is **conversation-level and fixed for the life of the event** —
  none of it depends on the current message or transcript. This is effectively 100% stable
  across every tick of a given conversation, same caching opportunity as §4.1.
- Also fires every 120 seconds (line 137). It does have a gate (lines 198–219,
  `minInterval`/`RATE_LIMIT_GRACE_MS`) — but it's a **cooldown timer since the agent's last
  intervention**, not an "did anything new happen" check. On every tick that isn't inside its
  cooldown, it still runs the full transcript fetch, DM-history fetch
  (`getConversationHistory`, up to 100 messages), and RAG search
  (`runInterventionAnalysis` → `interventionHandler.ts`) before the LLM call.

**Unlike `moderatorNotifier`, this agent's goals are not all reactive to new content — some
are reactive to its *absence*.** Reading `goals/*.json` (`channel: "groupChat"`, **eleven**
total — corrected from an earlier miscount), `provoke_participation`, `play_commentary`, and
`poll_reveal` all explicitly trigger on chat going quiet *while the transcript is still
active* — e.g. `provoke_participation`'s condition is "few or no participant messages in the
last few minutes... a speaker actively presenting to a passive audience fully satisfies this
trigger, including during opening introductions or the early minutes of an event." A gate that
skips whenever chat is quiet would silently disable these three goals' entire reason for
existing — that's the opposite of "no quality tradeoff."

**The gate should be three-way, keyed off which goals a given conversation actually has
enabled — not two-way.** `resolveActiveGoals`/`getEligibleGoals`
(`promptComposer.ts:90-104`) is a pure, cheap, config-driven filter over `conversation.goals`
(static per-event setup) with goal definitions already cached in memory
(`goals/loader.ts`) — `respond()` already computes `groupChatGoals` at line 166, before any
transcript fetch, DM fetch, or RAG search. Classifying all eleven group-chat goals by whether
they need chat activity to fire: `provoke_participation`, `play_commentary`, `poll_reveal`
don't (chat silence is the trigger); `missing_perspective` doesn't either — its condition is
"enough speakers have spoken in the *transcript*," with no reference to chat at all; the other
seven (`bridge_topics`, `challenge_consensus`, `clarify_confusion`, `invite_quieter_voices`,
`structure_conversation`, `surface_signal`, `synthesize_discussion`) all require actual chat
content — `challenge_consensus` even says so explicitly ("only use when the room is actively
exchanging messages — this goal is about the quality of an active discussion, not about
waking a passive one"). That gives:

- **Chat has new activity** → always run; the seven activity-dependent goals need it
  regardless of transcript state.
- **Chat quiet, transcript active** → run *only if* `groupChatGoals` intersects
  `{provoke_participation, play_commentary, poll_reveal, missing_perspective}`; **skip
  entirely otherwise** — a conversation configured without any of those four goals (e.g. an
  event that only enabled `structure_conversation`/`synthesize_discussion`) has nothing that
  could act on chat silence, so this is a full skip, not a backoff, with the same "nothing to
  react to" safety as `moderatorNotifier`'s gate.
- **Chat quiet, transcript quiet** → always skip (§4.2 original finding — nothing anywhere to
  react to for any goal).
- **Chat quiet, transcript active, and a silence-compatible goal *is* eligible** — this is the
  one case that still needs the **backoff**, not a skip: `provoke_participation`'s trigger
  depends on the *duration* of chat silence, not a discrete new event, so re-evaluation needs
  to continue (at a widening interval) rather than freeze at the first quiet tick's
  conclusion.

**Real data revises the expected impact of the goal-aware skip downward.** A read-only
production Mongo query (32 real conversations with `goals` configured) found **27/32 (84%)
have at least one of the four silence-compatible goals enabled** — and every sampled
conversation had the *identical* 14-goal list, strongly suggesting goals are a uniform
platform default today, not curated per event. **The goal-aware full-skip branch will rarely
fire under current configuration** — it's still correct and safe to ship (protects the 16%
minority today, and any future move toward curated goals), but isn't a meaningful lever on
its own yet. Separately, the same query bucketed 6 real conversations' message timestamps
into 10-minute windows and found only **8/77 (10.4%) genuinely both-channels-quiet** — the
real, measured ceiling for the "chat and transcript both quiet" branch, which applies
regardless of goal configuration.

**Shipped in this PR:** `evaluate()` now implements the three-way gate above (full skip on
both-quiet; full skip on chat-quiet-with-no-silence-goal; otherwise contribute — the fourth
case, chat-quiet-with-a-silence-goal-eligible, still runs at full cadence, see the backoff
note above) using the *same* `agentConfig.transcriptWindow` (10 min default) `respond()`
already uses for `recentTranscript`, so no new tunable. `getTraceMetadata()` now includes
`activeGoalIds` so the real hit rate becomes measurable going forward rather than assumed —
see §5 for what's still open.

**`moderatorNotifier` and `proactiveGroupAgent` independently fetch and RAG-search nearly
the same context every 120s tick**, separately from all of the above — shared chat history,
DM history across every direct channel, and a semantic search over nearly the same combined
text (`interventionHandler.ts:142-143` vs `moderatorNotifier.ts:199-200`). Deduplicating that
fetch (or at least the RAG search result) between the two agents cuts real, measurable cost
without changing either agent's decision logic, and stacks with the gating above.

### 4.3 `librarian` — the cleanest caching case in the codebase, structurally different from the other two

`src/agents/librarian/librarianAgent.ts` runs every 15 minutes (not 120s) and **does** gate on
new content (`transcript.length < minTranscriptLength` skip, line 112) — better-behaved than
the other two already. Its cost instead comes from being a genuine multi-step tool-use loop
(`getAgentStructuredResponse` with two Semantic Scholar tools): ~4 LLM calls per turn (535
calls / ~134 turns), each resending the full accumulating context from prior iterations in the
same turn. Unlike §4.1/§4.2's "mostly stable, rebuilt each time" prompts, this prefix is
**guaranteed byte-identical** call-to-call within a turn — exactly what incremental prompt
caching is built for, with no risk of a silent invalidator.

### 4.4 Why "conversations with more people" matters here, precisely

`getConversationHistory` (`src/agents/helpers/getConversationHistory.ts:29`) applies `count`
as a **global slice across all matched messages**, not per-channel
(`filteredMessages.slice(Math.max(0, length - count))` after filtering to the matched
channels) — so a single call's raw token size doesn't blow up as participant count grows; it's
bounded by `count` regardless of how many DM channels exist.

What *does* scale with participant count: more concurrent DM channels → higher aggregate
message velocity → the fixed 100-message/120-second window covers a shorter wall-clock span,
and consecutive periodic ticks overlap more heavily (re-sending largely the same recent
messages) the busier the event gets. This is a **redundant-recomputation** problem that scales
with conversation size, not a per-call token-size problem — which is exactly what §4.1/§4.2's
recommendations (gating/backoff, deduplicating the two agents' fetches, caching the stable
prefix) address, and why bigger, more active events are where those levers pay off the most.

---

## 5. Recommendations, prioritized

Items 1 and 2 below are **shipped in this PR**. Their real production hit rate is not yet
measured — the `logger.debug` skip-reason lines they add are the only way to see a skip at
all (a `REJECT` from `evaluate()` never reaches `respond()`, so there's no LangSmith trace
for a skipped tick — a structural limit, not an oversight). Their *expected* impact is
grounded in real data gathered this session (LangSmith call cadence across 7-8 sampled
conversations, and a read-only production Mongo query across 6-32 conversations) — real, but
from small samples, not a production measurement of these exact changes. Items 3-6 are not
implemented; still reasoned estimates.

1. **Shipped: `moderatorNotifier.evaluate()` now rejects when no message with
   `fromAgent: false` arrived within the last `timerPeriod` (120s)** (§4.1), on top of the
   framework's existing (coarser) gate. Real data bounds the *existing* gate's suppression at
   only ~7% of ticks and found 16-47% of messages are agent-authored — real support for this
   narrowing, though its own precise hit rate wasn't isolated separately before shipping.
2. **Shipped: `proactiveGroupAgent.evaluate()` now uses the three-way, goal-aware gate**
   (§4.2): run on chat activity; skip entirely when chat and transcript are both quiet; when
   chat alone is quiet, skip entirely unless the conversation's eligible goals include
   `provoke_participation`/`play_commentary`/`poll_reveal`/`missing_perspective`, in which case
   it still runs (backoff for that specific sub-case is explicitly **not** shipped — see
   below). Real data revises this lever's expected impact **down** from earlier reasoning:
   only ~10.4% of 10-minute windows are genuinely both-channels-quiet (bounds the
   both-quiet branch), and 84% of real conversations with goals configured already have a
   silence-compatible goal enabled — apparently from a uniform platform default, not curated
   per event — so the goal-aware full-skip branch will rarely fire *today*. `activeGoalIds`
   was added to `getTraceMetadata()` so this can be re-measured if goal curation changes.
3. **Not shipped: backoff for the "chat quiet, transcript active, silence-compatible goal
   eligible" sub-case.** Given the 84% figure above, this sub-case is *most* of what still
   runs at full cadence after #2. Deferred because it needs either an external reschedule
   call (`timerPeriod` is baked into the Agenda job at schedule time, not re-read per tick)
   or new persisted state (a schema field analogous to `lastActiveMessageCount`) — bigger,
   separate work. Worth revisiting once the skip-reason logs from #1/#2 show real numbers.
4. **Not shipped: deduplicate `moderatorNotifier`'s and `proactiveGroupAgent`'s per-tick
   context fetch** (§4.2) — both independently fetch and RAG-search nearly the same
   chat/DM/transcript content every 120s. A shared fetch (or a shared, memoized RAG result)
   cuts real cost with zero change to either agent's decision logic, and is fully additive
   with 1-3.
5. **Not shipped: extend `CACHE_BREAKPOINT_MARKER` (shipped for `eventAssistant` in this PR)
   to `moderatorNotifier` and `proactiveGroupAgent`.** Their prompts (37-85K avg tokens) are
   10-80x any model's cache-eligibility minimum, so — unlike `eventAssistant` — this isn't
   blocked by the Opus 4.6 minimum-prefix problem in the caching doc's §3/§6.
6. **Not shipped: incremental caching for `librarian`'s tool loop** (§4.3). Small in absolute
   dollars (8.2% of attributed cost) but essentially risk-free — the prefix reuse is
   guaranteed, not probabilistic.
7. **Not shipped: re-surface the model-choice item** (caching doc §6) as a system-wide
   question, not an `eventAssistant`-specific one — Opus 4.6 is 93.7% of *all* production LLM
   calls (§2), so whatever the eval-verified quality/cost tradeoff turns out to be, it applies
   to the dominant cost driver across the whole system.

**No combined savings percentage is claimed for 1-2.** An earlier draft of this doc reasoned
toward "10-20%"/"20%+" figures before any real data existed; real cadence and message data
gathered this session revise those down substantially (the both-quiet ceiling is ~10%, not
10-20%, and the goal-aware skip barely fires under current uniform goal configuration) — that
earlier figure is retracted, not softened. 1-2 are correct and safe regardless of their exact
size (neither can regress output quality — they only skip calls with nothing new, or nothing
eligible, to react to), and 4-6 remain the larger, better-substantiated levers in this
document.

---

## Appendix: experiment scripts

All under `scripts/experiments/` in this repo, read-only against LangSmith:

- `scratchListLangsmithProjects.ts` — discovers the real production project name (`llmEngine`)
- `scratchLangsmithStats.ts` — unfiltered 60-day aggregate (§2)
- `scratchLangsmithModelNames.ts` — model-name enumeration via `listRuns` (§2)
- `scratchLangsmithStatsByAgent.ts` — first per-agent attempt (`filter` on `isRoot`); superseded
  by the traceFilter/chunked versions below, kept as part of the debugging record (§1)
- `scratchLangsmithStatsByAgent2.ts` — `traceFilter` per-agent attempt over the full 60-day
  window; same totals as the chunked version, part of the three-method cross-check (§1)
- `scratchLangsmithChunkedBreakdown.ts` — the final, reconciled per-agent breakdown (§3)
- `scratchLangsmithRootNames.ts` — root-trace-name enumeration over a clean window (§1)
- `scratchLangsmithRootNamesRange.ts` — the same, over an older/heavier window; timed out
  before completing, part of the unresolved-gap record (§1)
- `scratchLangsmithUsageSurvey.ts` — earliest, slowest full-enumeration attempt (superseded by
  the aggregate-stats approach above; kept for the conversation-size metadata extraction
  pattern referenced in §4.4)
- `scratchCadenceAnalysis.ts` — per-conversation call-timestamp cadence analysis (§4.1/§4.2's
  "existing gate suppresses ~7%" and per-conversation actual-vs-expected-tick numbers)

No production **message content** was pulled or committed. Two kinds of query were used:
LangSmith aggregate/metadata fields (`getRunStats`/`listRuns`, as above — no message bodies
ever leave LangSmith's own trace payloads, which this repo doesn't store), and one read-only
production Mongo query (§4.1/§4.2's real percentages) run via `llm_engine-infra`'s
`scripts/llm-engine-prod-run.sh --mongo-eval` — an aggregate count/metadata query only
(`channels`, `fromAgent`, `createdAt`, `goals`), never `db.messages.find()` on `body`. The
query script itself lived only in the session scratchpad, not this repo.
