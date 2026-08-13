# Scorekeeper Agent

Nightly cron agent that fetches LangSmith online evaluator scores for all conversations
that ended in the last 24 hours and posts a quality report card per conversation to a
configured Slack channel.

Runs at **04:00 UTC** (approximately midnight US Eastern).

---

## How it works

1. At 04:00 UTC, the agent queries MongoDB for conversations with `endTime` in the
   last 24 hours where `endTime > startTime` (guards against restarted conversations).
2. For each conversation, it calls `fetchQualityScores`, which reads root LangSmith
   traces tagged with the `conversationId` metadata key and aggregates all feedback
   scores: mean, min, count, and low-score count per evaluator key.
3. It computes a 30-day cross-conversation baseline (minimum 5 reports) and derives
   per-evaluator deltas for trend arrows.
4. Results are persisted to `QualityReport` in MongoDB (one document per conversation
   per UTC day — idempotent) and posted as a Block Kit card to Slack.

Private conversations have their names redacted in both the Slack post and the
persisted report (`topic.private !== false` — fail-closed).

---

## LangSmith online evaluators — setup

Scorekeeper reads feedback that LangSmith's **online evaluators** write to each trace.
Online evaluators run automatically whenever a new root trace arrives in your project —
no manual trigger required.

### Step 1 — Enable LangSmith tracing

Ensure `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, and `LANGSMITH_TRACING=true` are set
in your environment. Each agent run must emit a root trace tagged with
`conversationId` in its metadata for Scorekeeper to find it.

### Step 2 — Create online evaluators in the LangSmith dashboard

In **LangSmith → your project → Evaluators → Online**, create one evaluator per
feedback key you want to track. Each evaluator runs the LLM-as-judge prompt defined
below against every new root trace.

Set the following on each evaluator:
- **Type:** LLM-as-judge
- **Scoring:** Continuous (0–1)
- **Feedback key:** exactly as shown — this becomes the key Scorekeeper reads
- **Model:** GPT-4o or equivalent; the same model used in `createJudge()` in
  `evaluations/sharedEvaluators.ts`
- **Sample rate:** adjust to budget; 100% gives the richest data

### Step 3 — Map prompts to feedback keys

All prompt text lives in `evaluations/sharedEvaluators.ts` (shared across all agent
suites) and `evaluations/qa-behavior/behaviorPolicyConfig.ts` (QA behavior suite).

#### From `evaluations/sharedEvaluators.ts` (all agent types)

| Feedback key | What it measures |
|---|---|
| `compliance.tone` | Whether the agent's tone matches the configured tone policy (warmSupportive, clearNeutral, playful, professional) |
| `compliance.formality` | Whether formality level (casual, semiFormal, formal) matches policy |
| `compliance.audienceAppropriateness` | Whether language is pitched correctly for the specified audience |
| `compliance.verbosity` | Whether response length (brief, medium, detailed) matches policy |
| `compliance.contentSensitivity` | Whether the agent respects sensitivity flags — avoids taking sides on contested topics |
| `compliance.privacyProtection` | Whether private participant messages are protected — no quoting or identification |
| `compliance.guardrailCompliance` | Whether the agent respects the active goal's guardrails |
| `compliance.interventionAppropriateness` | Whether the agent's decision to intervene (or stay silent) was appropriate given goals and initiative level |

Paste the corresponding `*_PROMPT` constant from `sharedEvaluators.ts` as the prompt
body in LangSmith. The prompts use `{context}`, `{inputs}`, and `{outputs}` variables
that LangSmith substitutes from the trace.

#### From `evaluations/qa-behavior/behaviorPolicyConfig.ts` (QA behavior agent type only)

| Feedback key | What it measures |
|---|---|
| `compliance.responseLengthCompliance` | Whether response length matches the configured tier (short, medium, long) |
| `compliance.answerScopeCompliance` | Whether content stays within the configured scope (lecture, subject area, company context, open) |
| `compliance.clarifyWhenAmbiguousCompliance` | Whether the agent asks a clarifying question when ambiguous (and doesn't when not) |
| `compliance.addContextWhenUsefulCompliance` | Whether the agent provides bridging context and scaffolding appropriately |
| `compliance.followUpDialogueCompliance` | Whether the agent signals openness (or closure) to continued dialogue per policy |

#### Event Assistant quality evaluators (from `evaluations/event-assistant/eventAssistantConfig.ts`)

These use built-in `openevals` prompts (`CORRECTNESS_PROMPT`, `HALLUCINATION_PROMPT`,
`RAG_HELPFULNESS_PROMPT`, `RAG_GROUNDEDNESS_PROMPT`, `RAG_RETRIEVAL_RELEVANCE_PROMPT`,
`CONCISENESS_PROMPT`) unless overridden in the config.

| Feedback key | Agent type | What it measures |
|---|---|---|
| `quality.correctness` | Event Assistant, Proactive Group Agent | Factual accuracy relative to context and general knowledge |
| `quality.conciseness` | Event Assistant | Whether the response contains only what was asked, without padding |
| `quality.helpfulness` | Proactive Group Agent | Whether the response actually helps the user accomplish their goal |
| `quality.hallucination` | Proactive Group Agent only | Whether the response fabricates information not present in context |
| `quality.groundedness` | Proactive Group Agent only | Whether claims are grounded in the retrieved context |
| `quality.retrievalRelevance` | Proactive Group Agent only | Whether the retrieved context was relevant to the question |

> **Note:** `hallucination`, `groundedness`, and `retrievalRelevance` are not applied to
> Event Assistant traces. Event Assistant uses web search as a tool, and the search
> results are not captured in the trace context — so these evaluators cannot accurately
> judge whether a response is grounded in or consistent with what the search actually
> returned.

#### Personality evaluators (from `tests/utils/evaluators.ts`, used by Event Assistant suite)

| Feedback key | What it measures |
|---|---|
| `personality.ceremony` | Whether the response skips unnecessary pleasantries and boilerplate |
| `personality.leadWithAnswer` | Whether the first sentence gives a direct answer or clear stance |
| `personality.antiSycophancy` | Whether the response avoids over-thanking, false agreement, and flattery |
| `personality.pragmatic` | Whether the response gives concrete, actionable guidance rather than vague platitudes |
| `personality.opinionatedBounded` | Whether the response makes clear recommendations while acknowledging alternatives |
| `personality.confidentNotCocky` | Whether the response is assertive without being condescending |
| `personality.witAndHumor` | Whether humor is dry, infrequent, and context-appropriate |
| `personality.honestyAboutLimits` | Whether the response explicitly acknowledges uncertainty rather than bluffing |

---

## Dot-notation key convention

Feedback keys use dot notation to group evaluators into categories on the report card:

```
compliance.tone          → category "compliance", name "Tone"
qa.responseLengthCompliance → category "qa", name "Response Length Compliance"
quality.correctness      → category "quality", name "Correctness"
```

Underscores and camelCase in the name segment are both rendered as title-cased words.
Keys with no dot are rendered without a category separator.

---

## Report card anatomy

Each Slack post contains:

- **Header** — conversation name (redacted for private topics)
- **Summary** — overall mean score and number of scored traces
- **Score table** — per-evaluator traffic light (🟢 ≥ 0.7 / 🟡 ≥ 0.5 / 🔴 < 0.5),
  mean score, score bar, and delta arrow vs. 30-day baseline (↑ / ↓ / →)
- **Trending Down** _(if applicable)_ — evaluators where delta ≤ −0.10, sorted
  worst-first
- **Needs Review** _(if applicable)_ — up to 5 traces with any score below 0.5,
  linked directly to LangSmith; shows total count if more than 5 exist
- **Footer** — generation timestamp and baseline sample count

---

## Baseline and trend arrows

Delta arrows compare today's per-evaluator mean against a 30-day rolling baseline
computed from all other conversations' persisted `QualityReport` documents:

- Requires **at least 5** reports in the window; suppressed when data is sparse
- The current conversation is excluded from its own baseline
- Arrow display threshold: **±0.02** (noise below this shows `→`)
- Trending Down alert threshold: **−0.10**

---

## Smoke-testing the Slack output

```bash
NODE_ENV=development node --loader ts-node/esm scripts/checkScorekeeperSlack.ts \
  --conversation=<scorekeeper-conversation-id> \
  --target-conversation=<conversation-to-score> \
  [--dry-run]
```

`--dry-run` fetches scores and renders the card without posting to Slack.

---

## Configuration

Create a `scorekeeper` conversation type with the following properties:

| Property | Required | Description |
|---|---|---|
| `slackChannel` | Yes | Slack channel ID (starts with `C` or `G`) |
| `slackWorkspace` | Yes | Slack workspace ID (starts with `T`) |
| `slackBotToken` | Yes | Bot User OAuth token (starts with `xoxb-`) |
| `slackBotUserId` | No | Bot user ID for routing incoming messages |
| `slackSigningSecret` | No | Signing secret; falls back to system-wide value |
| `botName` | No | Display name in Slack (default: `Scorekeeper`) |

LangSmith credentials are read from the application environment:

| Env var | Description |
|---|---|
| `LANGSMITH_API_KEY` | LangSmith API key |
| `LANGSMITH_PROJECT` | Project name that holds the traces |
