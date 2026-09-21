# Prompt caching on the Bedrock path — investigation notes

- **Tracking issue:** [berkmancenter/llm_engine#264](https://github.com/berkmancenter/llm_engine/issues/264) — "Enable Anthropic prompt caching on the Bedrock path"
- **Status:** Investigation complete; implementation not started. This document is the record of what was measured and what it implies, so the next person picking this up doesn't have to re-derive it.
- **Cost note:** All measurements below were done at effectively zero cost. Six intentional live-inference calls (~$0.05 total, tracked against a $20 approval ceiling) were used to *validate the caching mechanism itself and confirm real token counts* — every other number here comes from local computation or read-only production database queries (no writes, ever).

---

## 1. Why this matters (from the original issue)

`conversationcosts` snapshot (2026-08-19): **$786.86** total spend, 105 conversations, 17,989 LLM calls. **140.8M prompt tokens vs. 3.36M completion tokens (42:1)** — ~89% of spend is input tokens. Spend by agent: `eventAssistant` $502.64 (64%), `proactiveGroupAgent` $154.69, `librarian` $74.09, `moderatorNotifier` $49.39. Dominant model: `claude-opus-4-6` ($585.50 / 16,826 calls).

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

## 6. Open items / suggested next steps

Roughly in the order the original issue proposed, revised by everything above:

1. **Fix `bedrockUsage.ts`** to surface `cache_creation_input_tokens`/`cache_read_input_tokens` onto `usage_metadata` — small, safe, unblocks real measurement in production. Not yet done.
2. **Implement the sentinel-split mechanism** in `claudeHandler.ts` (§3) — fixes blocker #1, sidesteps blocker #2, and is the single change that turns on caching for every call site at once. Not yet done.
3. **Fix the two silent invalidators found in §2** (classification-dependent template swap, mid-block date interpolation) before or alongside step 2 — a correct mechanism on top of an unstable prefix still won't cache.
4. **Do not place a breakpoint on chat history/`messages`** for agents whose conversations exceed their configured window `count` (§2) — net negative there.
5. **Decide on Opus 4.6 specifically**: either commit to writing genuinely useful content to close the ~1,547-token gap (§5.1), or accept that Opus 4.6 stays largely uncached for `eventAssistant` and lean on model choice (§5.2) for the agents where caching should carry more weight. This is a real decision point, not yet made.
6. **Fix the `tavily_search`/`web_search` duplicate tool registration** (`src/agents/tools/registry.ts`) — worth doing regardless of caching.
7. **Consider the deferred-tool-stub pattern** for `member_bios`/`search_semantic_scholar`/`event_history` (§5) as a follow-up, not a blocker for the above.
8. Re-measure against the $787 cost baseline once steps 1–2 ship, per the original issue's step 5.

## Appendix: experiment scripts

All under `scripts/experiments/` in this repo (not yet committed as of this writing — ask before assuming they should ship as-is):

- `eventAssistantSystemPromptStability.ts` — §2 synthetic system-prompt prefix stability
- `chatHistoryWindowStability.ts` — §2 synthetic sliding-window behavior
- `liveCacheBreakpointTest.ts` — §3 live proxy validation (paid)
- `toolsPrefixSize.ts` — §3 zero-cost tool schema size (stubbed fetch)
- `realConversationStability.ts` — §4.1 real-data rerun of §2, takes an exported conversation JSON file as an argument
- `crossParticipantCacheTest.ts` — §4.3 live cross-participant cache sharing validation (paid)
- `maxObviousPrefixSize.ts` — §5 zero-cost "bind everything" measurement (superseded by the research in §5)
- `bkcArchiveWikiRealSize.ts` — §5 zero-cost real `bkc_archive_wiki` measurement

Production data exports used for §4 were **not** committed (contain real message content) — they live in the session scratchpad that produced them, not this repo.
