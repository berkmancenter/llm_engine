# Event Assistant Evaluations

This directory contains quality evaluations for the Event Assistant agent.

**⚠️ IMPORTANT:** These evaluations are specific to the Event Assistant and cannot be reused for other agents. The evaluation prompts and message structures are tailored to EA's Q&A format.

## Structure

```
event-assistant/
├── eventAssistantConfig.ts            # EA-specific evaluation prompts and types
├── runEventAssistantEvaluations.ts    # Standalone evaluation runner
└── README.md                          # This file
```

Test cases are stored in LangSmith dataset named `event-assistant` (configurable with `--dataset` flag).

## Running Evaluations

### Full Evaluation Suite

```bash
yarn evaluate:event-assistant
```

### Command Line Options

```bash
# Verbose output (shows individual evaluator scores)
yarn evaluate:event-assistant --verbose

# Use different dataset
yarn evaluate:event-assistant --dataset=my-custom-dataset
```

### Available Flags

**`--verbose`** - Shows detailed output for each evaluation including individual evaluator scores and comments

**`--dataset=NAME`** - Specifies which LangSmith dataset to use (defaults to `event-assistant`)

## Evaluation Types

The Event Assistant supports three evaluation types, configured in `eventAssistantConfig.ts`. The evaluation type is determined by the `promptType` field in the LangSmith example metadata. If no `promptType` is specified, the default evaluators (same as `semantic`) are used.

> **`correctness` is the only quality evaluator applied across all prompt types.** It is the only one that is meaningful regardless of how the response was generated. The others are scoped to types where the judge has the necessary context to score them accurately.

| Evaluator | `semantic` | `timeWindow` | `webSearch` |
|---|---|---|---|
| `correctness` | ✓ | ✓ | ✓ |
| `hallucination` | ✓ | ✓ | — |
| `groundedness` | ✓ | ✓ | — |
| `helpfulness` | ✓ | — | ✓ |
| `retrievalRelevance` | ✓ | — | — |
| Personality evaluators | ✓ | ✓ | ✓ |

**Why the gaps?**
- `hallucination` / `groundedness` require the judge to have the full source material. Web search results are not included in the context string, so the judge cannot reliably detect hallucinations.
- `retrievalRelevance` only makes sense when the response was built from RAG retrieval. Web search responses don't have a `## Relevant Retrieved Context` section to evaluate.
- `helpfulness` is excluded from `timeWindow` because those responses synthesize transcript content by time range — the rubric for "did it directly address the question" is less meaningful in that format.

### Prompt type reference

1. **`semantic`** — Standard Q&A responses backed by RAG retrieval from the event transcript
2. **`timeWindow`** — Catch-up queries that summarize recent content by time range
3. **`webSearch`** — Questions answered using live web search rather than transcript retrieval

## Adding Test Cases

Test cases are stored in the LangSmith dataset (default: `event-assistant`). You can add test cases manually or from production traces.

### Manual Test Case Creation

1. Go to https://smith.langchain.com
2. Navigate to the `event-assistant` dataset
3. Add a new example with:

**Required fields:**

- `inputs.input` - The user's question/input text

**Outputs (reference answers):**

- `outputs.outputs` - Primary expected answer
- `outputs.outputs_2` - Alternative expected answer (optional)
- `outputs.outputs_3` - Another alternative (optional)

**Metadata fields:**

- `metadata.promptType` - Evaluation type: `semantic`, `timeWindow`, or `webSearch`
- `metadata.context` - Context to provide to the agent (optional)
- `metadata.conversationHistory` - Prior conversation history (optional)

### Adding Production Traces to Dataset

The Event Assistant customizes its LangSmith traces to match the evaluation dataset format, making it easy to add production examples:

**Trace Customization** (implemented in `src/agents/eventAssistant/eventAssistant.ts:88-103`):

```typescript
formatTraceInput(conversationHistory, userMessage) {
  return userMessage?.body  // Just the question text
}

formatTraceOutput(responses) {
  return responses[0].message  // Just the answer text
}

getTraceMetadata(conversationHistory, userMessage, responses) {
  return {
    context: responses[0].context,         // RAG context used
    conversationHistory,                   // Full conversation
    channels: userMessage?.channels,       // Message source
    promptType: responses[0]?.promptType   // semantic/timewindow
  }
}
```

**What this means:**

- **Input**: Logged as simple string (user's question)
- **Output**: Logged as simple string (agent's answer)
- **Metadata**: Contains context, conversation history, and promptType for evaluation

**To add a production trace:**

1. Find interesting traces in LangSmith (look for edge cases, errors, or great responses)
2. Add the trace directly to the `event-assistant` dataset from the LangSmith UI
3. The trace format will match existing test cases automatically
4. Optionally add alternative reference answers (`outputs_2`, `outputs_3`) for evaluation

This workflow allows you to continuously expand your evaluation coverage with real production examples.

## CI vs Evaluation Suite

**CI Tests** (`tests/agents/eventAssistant/eventAssistant.agent.test.ts`):

- Functional assertions only
- No LLM-as-judge evaluations
- Run on every commit
- Fast and deterministic

**Evaluation Suite** (this directory):

- Quality and personality evaluation
- Uses LLM-as-judge
- Run on-demand, nightly, or pre-release
- Tracks quality trends over time

## Results

Each evaluation run creates a new experiment in LangSmith with a unique name:

**Format:** `event-assistant__<timestamp>__g<git-sha>`
**Example:** `event-assistant__2026-01-26T15-30-45-123Z__g45ed71b`

The experiment is linked to the `event-assistant` dataset for comparison.

### Viewing Results

1. Visit https://smith.langchain.com
2. Look for experiments matching the naming pattern above
3. The URL to the experiment is printed at the end of each run
4. View individual test results, evaluator scores (as feedback), and run metadata
5. Compare experiments over time by viewing the dataset's experiments tab

### What's Logged

For each test case run:

- **Run metadata**: Test case ID, inputs, outputs
- **Evaluator feedback**: Individual scores and comments for each evaluator
- **Latency**: Time between run creation and completion
- **Git SHA**: The commit used for this evaluation run

### Experiment Metadata

Each experiment includes:

- `llmPlatform`: The LLM platform used (e.g., "anthropic")
- `llmModel`: The specific model used (e.g., "claude-3-5-sonnet-20241022")
- `gitSha`: Short git commit hash
