# Prompt caching on the Bedrock path — investigation notes

- **Tracking issue:** [berkmancenter/llm_engine#264](https://github.com/berkmancenter/llm_engine/issues/264) — "Enable Anthropic prompt caching on the Bedrock path"
- **Status:** Investigation complete; implementation not started. This document is the record of what was measured and what it implies, so the next person picking this up doesn't have to re-derive it.
- **Cost note:** All measurements below were done at effectively zero cost. Six intentional live-inference calls (~$0.05 total, tracked against a $20 approval ceiling) were used to *validate the caching mechanism itself and confirm real token counts* — every other number here comes from local computation or read-only production database queries (no writes, ever).

## Bottom line

**Model choice beats caching by roughly 6–9x on expected dollars, for this workload today.** Ranked by savings: switching Opus 4.6 → Sonnet 4.6 alone (no caching, no prompt changes) is **40%** (§6.2); adding caching on top of that only gets to **44.2%** — caching is 4.2 of those 44.2 points, about 9.5% of the total (§6.3). If the org stays on the Opus tier instead (Opus 4.6 → Opus 5, same price), caching is **100%** of the available savings, but that's only **~7%** (§6.3–6.4). A skeptic who says "the model swap is the real lever, caching is a rounding error next to it" is reading the numbers correctly — say so plainly rather than defending caching as the main event.

**Why this work still has a claim on being worth doing, in order of how load-bearing each reason is:**

1. **This investigation is what produced the model-choice numbers**, not a parallel effort — the tier-savings percentages, the cost/length concentration (§4.2), and the fan-out discovery (§4.3) all came from digging into real token usage, which the caching question forced. There was no shortcut to the model analysis that skipped this.
2. **Two of the caching fixes are diagnostic/correctness work independent of caching's payoff** — surfacing `cache_creation_input_tokens`/`cache_read_input_tokens` (blocker #3) and fixing the `String()` coercion bug (blocker #1) are needed regardless of which model gets chosen; without them you can't measure whether *any* future decision is working.
3. **The implementation was small** — a handful of files (§7, now shipped in this pass), not a competing initiative against a model migration. It lands alongside a model decision, not instead of one.
4. **If Opus is non-negotiable, caching is the only lever left on the table** — modest (~7%, possibly more for the fan-out-heavy conversations specifically, §6.4), but it's the only money back available in that world.

What this document does **not** defend: pitching caching as the primary cost initiative on its own terms. It isn't. It's a smaller, mostly-complementary lever that happens to have produced the investigation that found the actual big one.

---

## 1. Why this matters (from the original issue)

`conversationcosts` snapshot (2026-08-19): **$786.86** total spend, 105 conversations, 17,989 LLM calls. **140.8M prompt tokens vs. 3.36M completion tokens (42:1)** — ~89% of spend is input tokens. Spend by agent: `eventAssistant` $502.64 (64%), `proactiveGroupAgent` $154.69, `librarian` $74.09, `moderatorNotifier` $49.39. Dominant model: `claude-opus-4-6` ($585.50 / 16,826 calls).

(Superseded by cumulative totals in §6 below, pulled later in this investigation — spend has grown since the Aug 19 snapshot. The agent/model concentration story hasn't changed, just the absolute numbers.)

**Nothing in the codebase sets `cache_control` today** — none of this spend is cached.

### Blockers identified in the original issue (still relevant)

1. **`src/agents/helpers/claudeHandler.ts`** — `transformPayloadForClaude` does `String((bodyContent as Record<string, unknown>).system)`. This blindly coerces `system` to a string, which would mangle a content-block array (`[object Object]`) if one were ever passed in. Needs to distinguish "already a block array" from "plain string, wrap it."
2. ~~**`BedrockChat` formats messages before our `fetchFn` sees them, so `cache_control` might not survive.**~~ **Revised finding (§4 below): this blocker is less severe than written.** `bedrockGateway.ts`'s `fetchFn` parses and fully rebuilds the JSON body *after* `BedrockChat` has already flattened everything to the plain Anthropic wire format. We don't need `cache_control` to survive LangChain's internal serialization — we can construct it ourselves entirely inside `claudeHandler.ts`, downstream of that serialization.
3. **`src/agents/helpers/bedrockUsage.ts`** — `attachUsageMetadata` only copies `input_tokens`/`output_tokens`; it drops `cache_creation_input_tokens`/`cache_read_input_tokens`. This needs fixing regardless of caching, to measure anything.

### The one invariant

Caching is a byte-level **prefix match**. Render order is `tools` → `system` → `messages`. Stable content must physically precede volatile content; a single byte difference at position N invalidates everything at positions ≥ N.

---

## 2. Structural findings (synthetic, zero cost)

Using the real prompt-assembly functions (`buildLLMTemplates`, `composeSystemPrompt`, `buildEventAssistantToolSystemPrompt`) with representative fixture data, no network calls:

- **System prompt structure is mostly fine.** For the `eventAssistant` tool path, the volatile `## Context:` block (live transcript + RAG results) genuinely is the *last* thing appended — 98.1% of the string was a stable byte-prefix across consecutive turns with only the transcript growing.
- **But two silent invalidators exist in that same path:**
  - **Classification-dependent template swap.** `eventQuestionHandler.ts` picks between `templates.semanticSystem` / `timeWindowSystem` / `offTopicSystem` / `unanswerableSystem` per turn based on an LLM classification call. A classification flip mid-conversation swaps the *base template text*, invalidating the entire prefix (measured: prefix collapsed from 98.1% to 2.7% shared).
  - **Mid-block date interpolation.** `buildSeriesHistoryRules` embeds `Today's date is ${today}` in the *middle* of an otherwise-stable block of tool-description text (and repeats it later in the same block). A date rollover fragments what should be one stable chunk (measured: 71.6% shared instead of ~100%).
- **Chat history is a dead end for caching, once conversations get long.** `getConversationHistory` (`src/agents/helpers/getConversationHistory.ts`) takes the last `count` messages via `slice(Math.max(0, length - count))` — a **fixed-size sliding window**, not append-only growth. Every call site (`eventQuestionHandler`, `checkinHandler`, `moderatorNotifier`, `proactiveGroupAgent`) passes a fixed `count` (10 default, 50/100, or an `agentConfig`-sized value).
  - Below the window: shared prefix ≈100% (pure growth) — synthetic and real-message tests agree.
  - Above the window: shared prefix ≈0.1–0.6% — every new turn drops the oldest message and shifts everything, so a breakpoint here writes on **every single call and is never read**. This is worse than not caching at all (1.25x write premium, zero reads), not merely neutral.
  - **Recommendation: do not place a `cache_control` breakpoint on `messages`/chat history for any agent whose conversations regularly exceed its window `count`.**

---

## 3. Live proxy validation (real inference, ~$0.03)

Confirmed against the real Bedrock proxy (`us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-opus-4-6-v1`), using `scripts/experiments/liveCacheBreakpointTest.ts`:

- **The proposed mechanism works.** A `system` array of two blocks — `[stable text + cache_control, volatile text]` — writes on call 1 (`cache_creation_input_tokens: 1343`) and reads on call 2 with an *identical* volatile block, **and still reads when the volatile block is completely different** (`cache_read_input_tokens: 1343` on call 3 with different content after the cached block). Changing the trailing block does not invalidate the cached leading block.
- **Opus 4.6's real stable prefix misses its own minimum.** Same content, real Anthropic tokenizer count: **1,330 tokens** for the whole system+user payload — well under Opus 4.6's 4,096-token minimum. Result: `cache_creation_input_tokens: 0` on every call. No write, no read.
- **Tools add to the same cumulative budget.** `tools` render before `system`, so a breakpoint after `system` needs `tools + system` combined to clear the minimum, not `system` alone. Real `web_search` tool schema alone: **+360 tokens** (measured with zero network cost via a stubbed-fetch capture of the real `BedrockChat`-serialized request body — see `scripts/experiments/toolsPrefixSize.ts`).

**Design implication:** the fix belongs entirely in `claudeHandler.ts`/`bedrockGateway.ts`'s `transformPayloadForClaude`. Prompt-builder call sites mark the stable/volatile boundary with a shared sentinel constant in the composed system-prompt *string*; `transformPayloadForClaude` splits on the sentinel (removing it) and emits `system: [{type:"text", text: stable, cache_control:{type:"ephemeral"}}, {type:"text", text: volatile}]`. This also fixes blocker #1 (no more blind `String()` coercion) as a side effect, and sidesteps blocker #2 entirely since the split happens downstream of `BedrockChat`'s own serialization.

---

## 4. Real production data (read-only, $0 — see `scripts/llm-engine-prod-run.sh --mongo-eval` in `llm_engine-infra`)

All queries were `aggregate`/`find`/`findOne` only. No writes were made to production at any point in this investigation.

### 4.1 Real stable-prefix size, recent conversations

Initial sample (5 longest `eventAssistant` conversations) turned out to be **4–7 months old** (Feb–May 2026), predating the issue's own Aug 19 cost snapshot — re-pulled scoped to the 5 most recent, substantial conversations (Sept 2–17, 2026) instead. Findings held up:

- Unlike the old batch, recent conversations **do** have `behaviorPolicy` and `goals` set (still no `conversationContext`) — these features are in active use now.
- Real stable system-prompt prefix, **including real `behaviorPolicy`**: **~1,491 tokens** across all 5 conversations — essentially identical to the synthetic estimate. Real `behaviorPolicy` JSON (tone/verbosity/formality/safety knobs) is compact and adds negligible bulk.
- Combined with the real `web_search` tool schema (~360 tok): **~1,850 tokens total** — still less than half of Opus 4.6's 4,096-token minimum, confirmed on current, real data.
- `goals` (list of goal IDs like `invite_quieter_voices`, `provoke_participation`) is set on these conversations but **`eventQuestionHandler`'s actual `composeSystemPrompt` call never passes `goals`** — those IDs look like they belong to `proactiveGroupAgent`, not this agent.
- Chat-history sliding-window finding reconfirmed on real message content: at turn 70→71 (count=50) and 120→121 (count=100), shared prefix was 0.1–0.4%.
- Aside, unrelated to caching: several real messages have `bodyType: 'json'`/`'multimodal'` with no `.text` field, hitting `extractMessageText`'s "defaulting to empty string" warning live in production.

### 4.2 Cost really does concentrate in long conversations

Across 30 conversations with both a cost record (`conversationcosts`) and message history: **Pearson correlation between message count and total cost = 0.828.**

| Quartile | Message count range | n | Total cost | Share |
|---|---|---:|---:|---:|
| Q1 | 3–258 | 8 | $40.37 | 2.7% |
| Q2 | 264–445 | 8 | $200.11 | 13.4% |
| Q3 | 509–715 | 8 | $293.91 | 19.6% |
| **Q4** | **777–1,539** | **6** | **$964.33** | **64.3%** |

The longest 20% of conversations account for ~two-thirds of all cost.

### 4.3 Fan-out, not just long threads

The top-cost *surviving* conversation ("BKC Launch event": $305.88, 2,061 calls, 1,539 messages) has **383 channels, 378 of them direct (DM)** — this is ~378 parallel per-participant DM threads (`checkinHandler.ts`'s pattern), not one shared group thread (~5.4 calls/participant on average).

This matters for caching: **the Anthropic API has no session/user concept — it keys purely on content bytes.** If the stable system+tools prefix is identical across all participants of the same event (it is: same `behaviorPolicy`, same tools, same topic), one participant's call can warm a cache entry that every *other* participant's call reads, provided they land within the same TTL window. **Real call-cadence data supports this being the common case:** for 5 sampled long conversations, 98–100% of consecutive same-conversation agent replies land within 5 minutes of each other (median gap 0–14 seconds).

**Live-verified** (`scripts/experiments/crossParticipantCacheTest.ts`, Sonnet 4.6, ~$0.02): two calls with completely unrelated content (different fabricated participant names, different questions, no shared identifier) — participant A writes the cache (`cache_creation_input_tokens: 1343`), participant B (different person entirely) reads it in full (`cache_read_input_tokens: 1343`, zero new write). **Cross-participant cache sharing within a fan-out event is real and confirmed, not theoretical.**

Aside: the single highest-cost record in prod ($458.27, 1,032 `eventAssistant` calls) points at a conversation that **no longer exists** (`conversations.findOne` returns null) — cost telemetry apparently outlives conversation deletion. Unrelated to caching; noting it because it was surprising.

---

## 5. "Grow the stable prefix" — why it's off the table as currently framed

Opus 4.6's real gap to its own minimum is large enough (~2,250+ tokens short of 4,096, even after including real `behaviorPolicy` and the `web_search` tool) that closing it looked temptingly easy by just binding more tools. **This is a known anti-pattern, not a viable lever:**

- Binding **every** registered tool (`tavily_search`, `web_search`, `search_semantic_scholar`, `get_semantic_scholar_recommendations`, `bkc_archive_wiki`, `event_history`, `member_bios`) got the combined estimate to ~4,315 calibrated tokens — technically over 4,096 — but **the entire margin was an artifact**: `tavily_search` and `web_search` are both registered as aliases for the *same* tool object, so "every registered tool" silently double-counts one schema (~360 tokens, almost exactly the margin). Fixing that legitimate duplicate (independently worth doing) drops it back under the minimum.
- **Research confirms this is the wrong direction generally, not just fragile in this instance:**
  - [Anthropic's own engineering guidance](https://www.anthropic.com/engineering/writing-tools-for-agents): *"More tools don't always lead to better outcomes... Too many tools or overlapping tools can also distract agents from pursuing efficient strategies."* This is a measured accuracy problem, not just a misuse risk.
  - Independent data (Epsilla's analysis of Anthropic's Tool Search feature): loading all tool schemas vs. discovering on demand moved tool-selection accuracy from **49%→74%** (Opus 4) and **79.5%→88.1%** (Opus 4.5).
  - Claude Code's own architecture (per [its prompt-caching docs](https://code.claude.com/docs/en/prompt-caching) and [its team's retrospective](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)) does the *opposite* of padding: tools that may not be needed get lightweight stubs with `defer_loading: true` — full schemas load only if the model selects them. Claude Code's system prompt clears the minimum because it's a broad coding agent with many genuinely-necessary core tools, not an engineered padding trick — that scope doesn't transfer to a narrow single-purpose Q&A agent.
  - The Anthropic API has **no native per-tool "visible but not callable" switch** — `tool_choice` is all-or-nothing (`auto`/`any`/one named tool/`none`). If a tool's schema is bound, the model can call it, full stop. The standard cross-provider mitigation is a **runtime allowlist**: keep the schema for consistency, but gate *execution* in your own code, rejecting/no-oping any call not permitted for the current context, and logging blocked attempts as a security signal. This is a real, usable pattern for `llm_engine`'s registry (especially the genuinely conversation-specific tools below) — but it's a defense-in-depth mitigation for necessary variability, not a justification for adding tools a conversation doesn't need.
- **One legitimate exception, measured:** `bkc_archive_wiki` is confirmed in active production use (not a misuse risk — it's already broadly relevant), so making it unconditional rather than gated isn't padding. Measured contribution (zero cost, real tool code with schema construction only — no network call): **+725 tokens (schema) + 353 tokens (guidance) = ~1,078 tokens.** Revised total with `web_search` + `bkc_archive_wiki` unconditional: **~2,549 calibrated tokens — still ~1,547 tokens short of Opus 4.6's minimum.**

### What's actually left as legitimate options

1. **Write genuinely useful new static content** (few-shot examples, a fuller style/citation guide) — the only "grow the prompt" option with no downside, since it pays for itself in output quality independent of caching. Not yet done; would need real authoring, not a config change.
2. **Right-size the model to the prompt, not the reverse.** The minimum cacheable prefix varies 8x across current models (512–4,096 tokens) specifically so you can match a model to your actual prompt size. **Already live-confirmed**: Sonnet 4.6 (1,024-token minimum) caches successfully today, with zero prompt growth, at the real current prefix size (~1,850 tokens). This is the lower-risk, already-proven lever for cost-sensitive/short-prompt agents.
3. **Deferred-tool-stub pattern for the genuinely conversation-specific tools** (`member_bios`, `search_semantic_scholar`, `event_history`) — these currently vary per conversation (a cache invalidator in their own right, independent of the misuse-risk question) and are exactly the tools that don't belong unconditionally bound. A lightweight, uniform stub per tool (cheap, same across every conversation) with full-schema loading gated by application logic (not just model discretion) would fix the cache-set-instability problem and the misuse-risk problem at the same time. Not yet implemented — would be new work, not a config flip.

---

## 6. Model choice: Opus vs. Sonnet, and Opus 4.6 vs. Opus 5 (read-only, $0)

Prompted by a separate question ("is it worth switching models") that turned out to connect directly back to the caching minimum. All numbers below are real historical token/cost totals pulled read-only from `conversationcosts` (`aggregate`/`$group`, no writes), re-priced under different rate cards — no prompts changed, no evals run.

### 6.1 Real cumulative spend by model (all agents combined)

| Model | Calls | Prompt tokens | Completion tokens | Actual cost |
|---|---:|---:|---:|---:|
| `claude-opus-4-6` | 16,085 | 323.8M | 6.74M | $1,787.53 |
| `claude-opus-5` | 1,181 | 39.7M | 0.65M | $213.66 |
| `claude-sonnet-4-6` | 255 | 0.31M | 0.02M | $1.23 |
| `claude-haiku-4-5` | 53 | 0.76M | 0.02M | $0.88 |
| **Total** | | | | **$2,003.30** |

Opus-tier is 99.9% of the bill — re-confirms §1's concentration finding on fresher data. Re-computing `promptTokens × $5/1M + completionTokens × $25/1M` for the `claude-opus-4-6` row reproduces its actual cost almost exactly ($1,787.53 vs. $1,787.53), which cross-checks that the pricing assumptions used throughout this section match what the app's own cost accounting already uses.

### 6.2 Tier-only savings (no caching, holding token counts fixed)

Sonnet 4.6 is priced at *exactly* 60% of Opus on both input and output ($3 vs. $5, $15 vs. $25) — so switching tiers is a clean, mix-independent 40% cut:

| Scenario | Rate ($/1M in, out) | Cost for the same tokens | vs. Opus 4.6 actual |
|---|---|---:|---:|
| Opus 4.6 / Opus 5 (same price) | $5 / $25 | $1,787.53 | — |
| Sonnet 4.6 | $3 / $15 | $1,072.52 | −40.0% |
| Sonnet 5 | $2 / $10 | $715.01 | −60.0% |
| Fable 5.1 ("latest, most powerful") | $10 / $50 | $3,575.06 | **+100%** |

Caveat: holds token counts fixed — an actual swap changes tokenizer and often response verbosity, so this is directionally solid, not exact to the dollar. Also: only 43 conversations have cost records total, too few to derive a responsible monthly run-rate — these are cumulative-since-tracking-began totals, not a rate.

### 6.3 Combined tier + caching (the part that changes the recommendation)

The minimum-cacheable-prefix table is **not monotonic by generation** — it's model-specific:

| Model | Minimum |
|---|---:|
| Opus 5, Fable 5, Mythos 5 | 512 |
| Opus 4.8, **Sonnet 4.6**, Sonnet 4.5, Sonnet 5 | 1,024 |
| Opus 4.7, Haiku 3.5 | 2,048 |
| **Opus 4.6**, Opus 4.5, Haiku 4.5 | 4,096 |

**`Sonnet 4.6` — a "4-series" model — already shares Opus 5's low practical minimum for our workload; `Opus 4.6` is the specific outlier**, tied for the highest minimum of any current model. "4-series has a higher threshold" isn't the right generalization; "Opus 4.6 specifically has a high threshold" is.

Applying this to our real ~1,850-token stable block (§3/§4.1) and Anthropic's cache pricing (writes 1.25x, reads 0.1x), assuming a 95% cache-read rate (grounded in the real cadence data in §4.3 — 98–100% of consecutive same-conversation calls land inside the 5-minute TTL; varying this 90–99% only moves the totals below by ±0.5 points, so it's not a fragile assumption):

| Model | No-cache cost | 1,850 tok clears min? | With-cache cost | Total savings vs. Opus 4.6 today | Caching's own share of that savings |
|---|---:|:---:|---:|---:|---:|
| **Opus 4.6 (current)** | $1,787.53 | ❌ No | $1,787.53 (caching inert) | — | — |
| **Opus 5** | $1,787.53 | ✅ Yes | $1,662.17 | $125.36 (**7.0%**) | **100%** — same price, pure caching |
| **Sonnet 4.6** | $1,072.52 | ✅ Yes | $997.31 | $790.22 (44.2%) | +$75.21 (4.2 pts) on top of the tier switch |
| **Sonnet 5** | $715.01 | ✅ Yes | $664.87 | $1,122.66 (62.8%) | +$50.14 (2.8 pts) on top of the tier switch |

**Why caching only ever adds a few points on top of whichever model is chosen:** the stable, cacheable block (~1,850 tok) is only ~9% of the ~20,133 avg prompt tokens/call for this workload — the other ~91% is live transcript + chat history, which §2 already showed doesn't cache well past the sliding-window size. Caching amplifies a model choice; it doesn't replace one.

### 6.4 Does the fan-out finding (§4.3) push these numbers higher?

Checked directly: **no, not by much, and not for the reason it looks like it should.**

The 95% read-rate assumption above already implicitly includes fan-out — it's derived from the same conversations' cadence data (98–100% of consecutive calls <5 min apart, median gap 0–14 seconds), and a *zero-second* median gap is itself a fan-out signature (many participants answered in the same burst, not one person chatting slowly). Fan-out isn't an additional effect to layer on top of 95%; it's most of what produced it.

More importantly: pushing the read rate to its **theoretical ceiling — 100% reads, essentially zero writes ever, the best fan-out could physically do** — barely moves the number:

| Read rate | Opus 5 with-cache cost | Savings vs. Opus 4.6 |
|---|---:|---:|
| 90% | $1,670.73 | 6.5% |
| 95% (used above) | $1,662.17 | 7.0% |
| **100% (theoretical max)** | **$1,653.62** | **7.5%** |

Going from "realistic" to "physically impossible best case" is worth **half a point (~$8 on $1,787).** The read/write ratio only sets the *discount* on the cacheable slice — and that slice is capped at ~9% of total tokens. Even a perfect 0.1x discount on 100% of 9% can't recover more than 9% has to give. Fan-out improves the odds of *hitting* the ceiling; it doesn't raise the ceiling. The ceiling is a structural property of the prompt (how much is stable vs. volatile), not of the traffic pattern.

**Two things fan-out surfaces that the 7.0% figure does *not* yet include — both point toward the real number being higher, not lower:**

1. **Per-participant chat-history caching, exempt from the §2 death spiral.** Each DM thread in a fan-out event is short (~5.4 calls/participant in the "BKC Launch event" sample, §4.3) — short enough to never hit the sliding-window ceiling that kills history caching for the big shared group-chat threads. A *second* breakpoint on each thread's own growing history could add savings on top of the system+tools number. Not sized here — would need per-thread call-count/size data not yet pulled — but additive, not already counted in §6.3.
2. **The ~9% figure is a population average across every call**, including large public Q&A turns with substantial RAG/transcript context. If DM check-in prompts run smaller per call (plausible — less context to carry than a public Q&A turn), the stable block is a *larger* fraction of exactly the fan-out conversations that are 64.3% of total cost (§4.2). That would make the real weighted savings for the dominant cost segment higher than the blended 7.0%. `conversationcosts` doesn't break tokens out by call-site (public Q&A vs. DM check-in), so this isn't quantified — it's a flagged follow-up, not a number to rely on yet.

**Net: treat 7.0% (Opus 4.6→5) as a conservative floor for the fan-out-heavy segment specifically, not a ceiling** — but don't round it up without doing the per-call-site query that would actually justify a bigger number.

### 6.5 The recommendation this implies

**Opus 4.6 → Opus 5 is close to a free win**: identical per-token price, no prompt changes, and it removes the specific reason caching is worth $0 on our dominant model today. This is compatible with (not in tension with) wanting "the latest, most powerful model" — Opus 4.6 is the one blocking caching, not the Opus tier itself. Two things stand between this and being real:

1. ~~The caching mechanism (§3) still has to actually ship~~ **Done** — see §7. `claude-opus-5` and `claude-sonnet-5` are also now added to `getModelChat.ts` (as explicit, non-default options — see §7), and both confirmed live-reachable on the HUIT gateway under their bare IDs (`us.anthropic.claude-opus-5`, `us.anthropic.claude-sonnet-5`, no `-v1` suffix unlike 4.6).

**The Sonnet-tier question (44–63% savings) is a separate, larger decision** — moving out of the Opus tier entirely — and caching doesn't add a new argument to it beyond the ~3–4 points above, since Sonnet 4.6 already caches fine today. That's a price/quality tradeoff (see below), not a caching one.

**Quality is deliberately out of every number above.** This repo already has LLM-judge evaluation suites wired to LangSmith (`evaluations/event-assistant`, `checkin`, `qa-behavior`, `proactive-group-agent`), and each runner already reads its model from `TEST_LLM_PLATFORM`/`TEST_LLM_MODEL` env vars — re-running them against candidate models is a config change away, not new infrastructure. Not run as part of this investigation (explicitly deferred, and it costs real inference money across however many models get compared) — it's the natural next step before treating any model-switch recommendation as settled, especially the Sonnet-tier one.

---

## 7. Implementation status

**Shipped in this pass** (see the handoff doc, `docs/investigations/prompt-caching-bedrock-handoff.md`, for exact files, test coverage, and what's next):

1. ✅ **`bedrockUsage.ts`** now surfaces `cache_creation_input_tokens`/`cache_read_input_tokens` onto `usage_metadata.input_token_details` — the standard LangChain shape (`cache_read`/`cache_creation`).
2. ✅ **The sentinel-split mechanism** — `CACHE_BREAKPOINT_MARKER` exported from `claudeHandler.ts`; `transformPayloadForClaude` splits `system` on it into `[stable + cache_control, volatile]`, and also fixes the blind `String()` coercion (blocker #1) by passing an already-array `system` through unchanged.
3. ✅ **`buildEventAssistantToolSystemPrompt.ts`** inserts the marker right before `## Context:` — the highest-value call site (§3–§4) is wired up.
4. ✅ **The mid-block date invalidator** — `buildSeriesHistoryRules` no longer interpolates `today` where the workflow instructions are discussed; both mentions are consolidated into a single trailing line, so a date rollover only invalidates one line instead of the whole block (§2, §6.4).
5. ✅ **The `tavily_search`/`web_search` duplicate** — fixed generally in `getTools` (dedupes by resolved tool `.name`), not by removing the alias (which is intentionally tested elsewhere).
6. ✅ **`claude-opus-5` and `claude-sonnet-5`** added to `getModelChat.ts` as explicit, selectable options — confirmed live-reachable on the HUIT gateway (bare IDs, no `-v1` suffix). **Not** wired as the `opus`/`sonnet` family defaults — that's the model decision below, deliberately not made here.

**Deliberately not done, in order of why:**

- **Classification-dependent template swap** (§2) — left as a documented, measured limitation. Restructuring 4 templates to share a stable preamble is real content-authoring work; decide whether it's worth it using real classification-flip-frequency data from #1's new telemetry once it's live, not a guess.
- **Chat-history/`messages` caching** — not implemented anywhere, by design (§2): net negative for any agent whose conversations exceed its window `count`.
- **Growing the stable prefix via extra tool bindings** — not implemented, by design (§5): research-backed anti-pattern.
- **The deferred-tool-stub pattern** for `member_bios`/`search_semantic_scholar`/`event_history` (§5) — real, separate engineering effort; only pursue if production telemetry (now possible via #1) shows tool-set churn is actually hurting hit rate.
- **Running the LangSmith eval suites** against Opus 5/Sonnet 4.6/Sonnet 5 (§6.5) — explicitly deferred, costs real inference money, needs to happen before any model-default change.
- **Extending the marker to other agents** (`checkinHandler.ts`, `proactiveGroupAgent.ts`, `moderatorNotifier.ts`) or to `eventQuestionHandler`'s non-tool/classification path — not done; each has its own stable/volatile shape that hasn't been individually measured.
- **Re-measuring against the cost baseline in production** — can't happen until this ships and runs against real traffic.

## Appendix: experiment scripts

All under `scripts/experiments/` in this repo:

- `eventAssistantSystemPromptStability.ts` — §2 synthetic system-prompt prefix stability
- `chatHistoryWindowStability.ts` — §2 synthetic sliding-window behavior
- `liveCacheBreakpointTest.ts` — §3 live proxy validation (paid)
- `toolsPrefixSize.ts` — §3 zero-cost tool schema size (stubbed fetch)
- `realConversationStability.ts` — §4.1 real-data rerun of §2, takes an exported conversation JSON file as an argument
- `crossParticipantCacheTest.ts` — §4.3 live cross-participant cache sharing validation (paid)
- `maxObviousPrefixSize.ts` — §5 zero-cost "bind everything" measurement (superseded by the research in §5)
- `bkcArchiveWikiRealSize.ts` — §5 zero-cost real `bkc_archive_wiki` measurement
- `probeOpus5Sonnet5ModelIds.ts` — §6.5/§7 live model-ID discovery (near-$0; invalid IDs reject before billing)

Production data exports used for §4 were **not** committed (contain real message content) — they live in the session scratchpad that produced them, not this repo.

See `docs/investigations/prompt-caching-bedrock-handoff.md` for a self-contained summary of what shipped, what's verified, and what to do next.
