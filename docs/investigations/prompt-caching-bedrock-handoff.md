# Handoff: prompt caching on the Bedrock path

Self-contained status doc — read this first, before the full investigation notes. It tells you what shipped, what's verified, and exactly what to do next. It does not repeat the reasoning or the numbers behind each decision; that's all in `docs/investigations/prompt-caching-bedrock.md` (referenced by section below where it matters).

- **Tracking issue:** [berkmancenter/llm_engine#264](https://github.com/berkmancenter/llm_engine/issues/264)
- **Full investigation notes:** `docs/investigations/prompt-caching-bedrock.md` — read its "Bottom line" section for the headline verdict (model choice saves far more than caching does) before doing anything with the model-decision item below.
- **Related:** `docs/investigations/llm-cost-savings-survey.md` — system-wide follow-on covering
  the ~45% of production cost outside `eventAssistant`, including two agents that are better
  caching candidates than `eventAssistant` and a non-caching, no-eval-required lever
  (skip idle periodic ticks).
- **This doc's status:** implementation landed and shipped — see [PR #340](https://github.com/berkmancenter/llm_engine/pull/340).

## TL;DR

Prompt caching is now mechanically wired up (nothing sets `cache_control` before this). It will do nothing for `eventAssistant`'s dominant model (Opus 4.6) until someone decides to move to Opus 5 — that decision needs LangSmith eval verification first, which was explicitly **not** run as part of this work (real inference cost, needs separate budget approval). Everything else below is either shipped, or deliberately deferred with a stated reason.

## What shipped

| File | Change |
|---|---|
| `src/agents/helpers/bedrockUsage.ts` | `attachUsageMetadata` now surfaces `cache_creation_input_tokens`/`cache_read_input_tokens` onto `usage_metadata.input_token_details.{cache_creation,cache_read}` (standard LangChain shape). Previously dropped entirely — this is the only way to see cache activity once it exists. |
| `src/agents/helpers/claudeHandler.ts` | New exported `CACHE_BREAKPOINT_MARKER` constant. `transformPayloadForClaude` no longer blindly `String()`-coerces `system` (an array now passes through unchanged). A plain string containing the marker is split into `system: [{type:"text", text: stable, cache_control:{type:"ephemeral"}}, {type:"text", text: volatile}]`; without the marker, behavior is unchanged from before this PR. |
| `src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.ts` | Inserts `CACHE_BREAKPOINT_MARKER` right before `## Context:` — the boundary between the stable (system template + tool rules + topic) and volatile (live transcript + RAG) parts of the prompt. Also: `buildSeriesHistoryRules` no longer interpolates `today` where the workflow instructions are discussed; both date mentions are consolidated into one trailing line, so a date rollover invalidates one line instead of the whole block. |
| `src/agents/tools/registry.ts` | `getTools` now dedupes by the resolved tool's own `.name`, not by requested registry key. Fixes `tavily_search`/`web_search` (both alias the same tool object) silently double-binding the same schema when something requests "every registered tool." The alias registration itself is untouched — it's intentionally tested (`tests/unit/agents/tools/registry.test.ts`). |
| `src/agents/helpers/getModelChat.ts` | Added `claude-opus-5` and `claude-sonnet-5` as new `supportedModels` entries and `modelFamilies` keys (`opus-5`, `sonnet-5`). **The bare `opus`/`sonnet` family aliases and `defaultLLMModel` are unchanged** — nothing defaults to the new models. Both confirmed live-reachable on the HUIT Bedrock gateway under `us.anthropic.claude-opus-5` and `us.anthropic.claude-sonnet-5` (bare IDs, no `-v1` suffix, unlike 4.6). |
| `tests/agents/helpers/claudeHandler.test.ts` | New `describe('cache breakpoint marker', ...)` block: split behavior, marker removal, no-volatile-content case, no-marker passthrough, array-passthrough. |
| `tests/agents/helpers/bedrockUsage.test.ts` | New cases for `cache_read`/`cache_creation` surfacing and the no-cache-activity case (`input_token_details` omitted entirely). |
| `scripts/experiments/probeOpus5Sonnet5ModelIds.ts` | The live probe that discovered the real model IDs above. Kept as part of the experiment-script record (see the main doc's Appendix). |

**Not changed:** `eventQuestionHandler.ts`'s non-tool/classification call path (`getChatPromptResponse`), and every other agent (`checkinHandler.ts`, `proactiveGroupAgent.ts`, `moderatorNotifier.ts`) — none of them insert the marker yet. Their prompts weren't individually measured for a stable/volatile split in this pass. `eventAssistant`'s tool path was the one call site sized and validated (§3–§4 of the main doc); extending further is real, separate work per agent.

## Verification performed

- `yarn build` (tsc): clean.
- `yarn lint` (eslint `src/` `tests/`): 0 errors; 5 pre-existing warnings, none in touched files.
- `npx prettier --check` on every touched file: clean.
- Unit tests, run directly (not via `yarn test`/`yarn test:agents` — see note below):
  - `tests/unit/agents/tools/registry.test.ts`, `tests/unit/agents/eventAssistantToolPrompt.test.ts`, `tests/unit/agents/eventAssistantSeriesHistoryGuidance.test.ts` — **37/37 pass** (main jest config, needs local MongoDB — confirmed reachable in this worktree).
  - `tests/agents/helpers/claudeHandler.test.ts`, `tests/agents/helpers/bedrockUsage.test.ts`, `tests/agents/helpers/bedrockChatWithUsage.test.ts` — **47/47 pass** (agent jest config; `TEST_LLM_PLATFORM=bedrock` in `.env` means the vLLM ping in `jest.agent.globalSetup.js` is skipped, and `EMBEDDINGS_API_URL` is unset so that ping is skipped too — no live model dependency for these specific files).
- **Not run:** the full `yarn test` / `yarn test:agents` suites (would take much longer and touch unrelated code); only the files plausibly affected by this change were run directly with `npx jest -i --config <config> <files>`. Run the full suites before merging, not just this list.
- **Not run:** `yarn evaluate:*` (the LangSmith LLM-judge suites) — explicitly deferred, see below.

## What's deliberately NOT done, and why

1. **No model-default change.** `claude-opus-5`/`claude-sonnet-5` are selectable but not the default. The main doc's §6 shows Opus 4.6→5 is close to a free win on cost, but "close to free" still needs eval verification before it's actually adopted — a newer model isn't guaranteed to be a drop-in on quality/behavior even at flat pricing.
2. **No eval runs.** `evaluations/event-assistant` (and `checkin`/`qa-behavior`/`proactive-group-agent`) already read their model from `TEST_LLM_PLATFORM`/`TEST_LLM_MODEL` env vars — running them against `opus-5` is a config change, not new code. This costs real inference money and was explicitly excluded from this pass. **This is the next real step before treating any model change as decided.**
3. **Classification-template-swap invalidator left alone** (main doc §2). Real content-authoring work (merging 4 templates' stable preambles); decide whether it's worth it using real classification-flip-frequency data, which is now measurable in production once #1 above ships and runs for a while.
4. **No chat-history caching anywhere.** By design — net negative once a conversation exceeds its window `count` (main doc §2). Don't add this without re-reading that section first.
5. **No prefix-growing via extra tool bindings.** By design — research-backed anti-pattern (main doc §5). Don't reach for this if the Opus 4.6 gap ever comes up again.
6. **No deferred-tool-stub pattern** for `member_bios`/`search_semantic_scholar`/`event_history`. Real, separate effort; only worth it if production telemetry (now possible) shows tool-set churn hurting hit rate.
7. **No production re-measurement.** Can't happen until this merges and deploys — there's no staging traffic to measure against yet.

## Immediate next steps, in order

1. ~~**Review and commit/push this work**~~ **Done** — [PR #340](https://github.com/berkmancenter/llm_engine/pull/340) is open.
2. **Deploy and watch `cache_read_input_tokens`/`cache_creation_input_tokens`** on real `eventAssistant` tool-path traffic. Expect: writes on the first call of a warm-cache window, reads on everything after, for calls sharing an event (including across different participants' DM threads — this is real, live-verified behavior, not a hope; see main doc §4.3). If reads stay at zero, something's broken — diff two consecutive request payloads and check the prefix is actually byte-identical up to the marker.
3. **Confirm Opus 4.6 genuinely shows zero cache activity** (expected — its 1,850-token stable prefix is under its 4,096-token minimum, confirmed live in the investigation). This isn't a bug; it's exactly why the model-choice conversation in the main doc's §6 matters.
4. **Scope and run the LangSmith eval comparison** (Opus 5, and Sonnet 4.6/5 if that's still on the table) against `evaluations/event-assistant` at minimum — get a budget number approved before running, same as every other live call in this investigation.
5. **Make the model decision** using the eval results plus the main doc's §6 cost numbers, then flip `getModelChat.ts`'s `opus`/`sonnet` family default or whichever agents' configured models, as a separate, deliberate change — not bundled into a caching PR.
6. **In parallel, not gated on the model decision:** `docs/investigations/llm-cost-savings-survey.md` found two agents (`proactiveGroupAgent`, `moderatorNotifier`, 32.8% of attributed system-wide cost) that are better caching candidates than `eventAssistant` — their prompts are well above any model's cache minimum — plus a non-caching "skip idle periodic ticks" lever with no eval requirement and no quality risk. These don't need to wait on steps 3–5.
7. **Only after the model decision settles**, extend `CACHE_BREAKPOINT_MARKER` to any remaining agents/call sites, sizing each one individually first (don't assume `eventAssistant`'s ~9% stable fraction generalizes — the survey doc already found it doesn't for `proactiveGroupAgent`/`moderatorNotifier`).
