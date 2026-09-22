# System-wide LLM cost survey — beyond `eventAssistant` caching

- **Status:** Investigation only; nothing in this document has been implemented. It's a
  follow-on to the caching work in `docs/investigations/prompt-caching-bedrock.md` (see that
  doc for the caching mechanism itself, and for the Opus 4.6 → Opus 5 model-choice analysis —
  this doc doesn't repeat either).
- **Scope:** Where does the other ~45% of production LLM cost go (everything outside
  `eventAssistant`'s tool path), and what — beyond caching — is actually driving it.
- **Cost:** $0. Everything below is read-only aggregate queries against LangSmith
  (`getRunStats`/`listRuns`, no writes) plus static code reading. No live inference calls.

## Bottom line

**Two periodic agents — `proactiveGroupAgent` and `moderatorNotifier` — run on a fixed
120-second clock for the full duration of every live event, regardless of whether anything
new happened, and together are ~33% of attributed production cost.** Neither is caching-blocked
the way `eventAssistant` is (their prompts are 15–85K tokens on average — far above any model's
cache minimum), and `moderatorNotifier` has no "anything new?" gate at all before it re-fetches
transcript, re-runs a RAG search, re-fetches DM/chat history, and calls the LLM.

**Important correction from an earlier draft of this doc:** a blanket "skip when nothing new
happened" gate is safe for `moderatorNotifier` but is **wrong** for `proactiveGroupAgent` — three
of its ten group-chat goals (`provoke_participation`, `play_commentary`, `poll_reveal`) exist
specifically to fire *because* chat has gone quiet while a speaker is still talking. Gating on
chat silence would disable the agent's core value, not just its cost. See §4.2 for the
narrower, safe version of this idea and why even that has a limit.

Independent, additive, low-risk levers that don't require a model decision or eval
verification:

1. **`moderatorNotifier`: skip the call entirely when nothing new arrived since the last
   tick** (§4.1) — safe, since all its triggers are pattern-accumulation from new content;
   "nothing new" really does mean "nothing to find."
2. **`proactiveGroupAgent`: skip only when *both* chat and transcript are empty for the
   window, not just chat** (§4.2) — narrower than #1, preserves every goal's real trigger
   condition, and use backoff (not a hard skip) for the "chat's been quiet, transcript's
   still running" case, since some goals depend on the *duration* of quiet, not just its
   presence.
3. **Extend `CACHE_BREAKPOINT_MARKER` (already shipped for `eventAssistant`) to both
   agents** (§4.1, §4.2) — their large prompts mean caching isn't blocked by the Opus
   4.6 minimum problem documented in the caching doc's §3/§6.
4. **Stop the two agents from independently re-fetching and re-searching nearly the same
   context every tick** (§4.2) — a shared per-tick fetch/RAG result would cut real cost
   with zero behavior change to either agent's decisions.

All of these are estimated, not measured (no caching or gating has shipped for these agents
yet) —
see §5 for the reasoning and why this is a floor, not a precise figure.

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

### 4.1 `moderatorNotifier` — fully static system prompt, no activity gate

`src/agents/moderatorNotifier/moderatorNotifier.ts`:

- `SYSTEM_PROMPT` (lines 11–54) is **byte-for-byte static** — zero interpolation. A textbook
  `cache_control` candidate, and unlike `eventAssistant`'s ~1,850-token stable prefix, this
  agent's prompts average 85,631 tokens — nowhere near any model's cache-eligibility floor.
- `defaultTriggers.periodic.timerPeriod: 120` (line 111) — fires every 2 minutes for the
  entire event, with **no check anywhere in `respond()` (lines 164–222) for whether anything
  new arrived** since the last tick. Every tick unconditionally: re-fetches the transcript
  (`transcript.getTranscript`, 600s window), re-runs a RAG search over it
  (`transcript.searchTranscript`), re-fetches and reformats up to 100 shared-chat messages and
  100 direct-message-channel messages (across *every* DM channel in the conversation), then
  calls the LLM.
- `USER_TEMPLATE` (lines 56–76) interpolates `previousAlerts`, `recentTranscript`,
  `retrievedChunks`, `privateMessages`, `sharedChatHistory` — all rebuilt from scratch each
  tick, all volatile by construction even when the underlying data barely changed between
  consecutive 120-second windows.

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
are reactive to its *absence*.** Reading `goals/*.json` (`channel: "groupChat"`, 10 total):
`provoke_participation`, `play_commentary`, and `poll_reveal` all explicitly trigger on chat
going quiet *while the transcript is still active* — e.g. `provoke_participation`'s condition
is "few or no participant messages in the last few minutes... a speaker actively presenting to
a passive audience fully satisfies this trigger, including during opening introductions or the
early minutes of an event." A gate that skips whenever chat is quiet would silently disable
these three goals' entire reason for existing — that's the opposite of "no quality tradeoff."

Two things are still true and useful, though:

- **Skipping when *both* chat and transcript are empty for the window is safe.** All ten
  group-chat goals need either new chat content or an active transcript to react to; none
  fire on literal silence across both channels (that state most plausibly means the session
  hasn't started, is on a break, or has an AV outage — not a moment calling for a nudge).
  Worth confirming `transcript.getTranscript` reliably returns empty/falsy for "nothing said"
  before relying on this.
- **Even that narrower gate shouldn't be a hard "skip if unchanged since last tick."**
  `provoke_participation`'s trigger is about the *duration* of chat silence while transcript
  stays active, not a discrete new event — two minutes of quiet and ten minutes of quiet look
  identical under a "nothing new happened" check, but only one of them is likely to warrant an
  intervention. A pure change-detection gate would freeze the agent's silence judgment at
  whatever it concluded on the first quiet tick and never revisit it as the silence lengthens.
  A **backoff** (widen the interval between checks during a stable "quiet chat, active
  transcript" stretch, reset immediately on any new content) preserves that re-evaluation
  while still cutting frequency, where a hard skip would not.
- **`moderatorNotifier` and `proactiveGroupAgent` independently fetch and RAG-search nearly
  the same context every 120s tick** — shared chat history, DM history across every direct
  channel, and a semantic search over nearly the same combined text
  (`interventionHandler.ts:142-143` vs `moderatorNotifier.ts:199-200`). Deduplicating that
  fetch (or at least the RAG search result) between the two agents cuts real, measurable cost
  without changing either agent's decision logic.

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

None of these are measured savings — no gating or caching has shipped for these agents.
They're reasoned estimates from the production shares in §3 and the code behavior in §4;
treat the percentages as a floor, not a validated number, until each ships and is
re-measured (same caveat the caching doc raises for its own numbers).

1. **Add an activity gate to `moderatorNotifier`: skip when nothing arrived since the last
   tick.** Safe without qualification — every one of its triggers is pattern-accumulation
   from new content (§4.1), so "nothing new" really does mean "nothing to find."
2. **For `proactiveGroupAgent`, gate on "chat and transcript both empty for the window," not
   "no new messages"** (§4.2) — a blanket "skip if unchanged" gate would disable
   `provoke_participation`, `play_commentary`, and `poll_reveal`, whose entire trigger
   condition *is* chat going quiet while the transcript stays active. Pair this with a
   **backoff** (not a hard skip) for the "chat quiet, transcript active" case specifically,
   since that trigger depends on how long the quiet has lasted, not just whether it's new.
3. **Deduplicate `moderatorNotifier`'s and `proactiveGroupAgent`'s per-tick context fetch**
   (§4.2) — both independently fetch and RAG-search nearly the same chat/DM/transcript
   content every 120s. A shared fetch (or a shared, memoized RAG result) cuts real cost with
   zero change to either agent's decision logic, and is fully additive with #1/#2.
4. **Extend `CACHE_BREAKPOINT_MARKER` (shipped for `eventAssistant` in this PR) to
   `moderatorNotifier` and `proactiveGroupAgent`.** Their prompts (37–85K avg tokens) are
   10–80× any model's cache-eligibility minimum, so — unlike `eventAssistant` — this isn't
   blocked by the Opus 4.6 minimum-prefix problem in the caching doc's §3/§6.
5. **Add incremental caching to `librarian`'s tool loop** (§4.3). Small in absolute dollars
   (8.2% of attributed cost) but essentially risk-free — the prefix reuse is guaranteed, not
   probabilistic.
6. **Re-surface the model-choice item** (caching doc §6) as a system-wide question, not an
   `eventAssistant`-specific one — Opus 4.6 is 93.7% of *all* production LLM calls (§2), so
   whatever the eval-verified quality/cost tradeoff turns out to be, it applies to the
   dominant cost driver across the whole system.

These are additive and individually estimated — no combined percentage is claimed here (an
earlier draft of this doc claimed "20%+" from #1+#4 alone using the now-corrected, overbroad
version of #2; that specific figure is retracted, not just softened). None of 1–4 require eval
verification the way a model change (#6) does, and #1 in particular can't regress output
quality — it only skips calls with nothing to respond to. #2 needs the same care in
implementation as it did in this analysis: get the gate condition right, not just "less
frequent."

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

No production message content was pulled or committed — every query here used
`getRunStats`/`listRuns` aggregate/metadata fields only.
