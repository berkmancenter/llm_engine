# LLM Agent Evaluations

This directory contains standalone evaluation suites for LLM agents. Each agent has its own evaluation directory with agent-specific prompts, test cases, and evaluation runner.

## Structure

```
evaluations/
├── templates.ts                  # Shared conversation templates (event types, behavior policies, audience)
├── sharedEvaluators.ts           # Shared LLM-as-judge evaluator prompts and factory
├── event-assistant/              # Event Assistant evaluations
│   ├── eventAssistantConfig.ts      # EA-specific prompts and evaluation types
│   ├── runEventAssistantEvaluations.ts  # Standalone runner
│   └── README.md
├── proactive-group-agent/        # Proactive Group Agent evaluations
│   ├── proactiveGroupAgentConfig.ts # PGA-specific prompts and evaluation types
│   ├── runProactiveGroupAgentEvaluations.ts  # Standalone runner
│   ├── seedDataset.ts               # Seeds starter scenarios into LangSmith
│   └── README.md
├── checkin/                      # Event Assistant private DM check-in evaluations
│   ├── checkinConfig.ts             # Evaluator registry and judge context builder
│   ├── runCheckinEvaluations.ts     # Standalone runner
│   ├── seedDataset.ts               # Seeds starter scenarios into LangSmith
│   └── README.md
└── README.md                     # This file
```

## CI Tests vs Evaluation Suites

### CI Tests (`tests/agents/<agent>/<agent>.agent.test.ts`)

- **Purpose**: Fast, deterministic functional validation
- **What**: Classification checks, structure validation, deterministic assertions
- **When**: Every commit
- **Tools**: Jest with standard assertions
- **No**: LLM-as-judge evaluations

### Evaluation Suites (`evaluations/<agent>/`)

- **Purpose**: Quality assessment with LLM-as-judge
- **What**: LLM-as-judge evaluations for correctness, hallucination, groundedness, helpfulness
- **When**: On-demand, nightly, or pre-release
- **Tools**: Standalone TypeScript with LangSmith SDK
- **Data**: Test cases stored in LangSmith datasets
- **Yes**: LLM-as-judge evaluations

## Running Evaluations

### Event Assistant

```bash
# Full suite
yarn evaluate:event-assistant

# Verbose output
yarn evaluate:event-assistant --verbose

# Custom dataset
yarn evaluate:event-assistant --dataset=my-dataset-name
```

### Proactive Group Agent

```bash
yarn evaluate:proactive-group-agent
yarn evaluate:proactive-group-agent --verbose
yarn evaluate:proactive-group-agent --dataset=my-dataset-name
```

### Checkin (Event Assistant private DMs)

```bash
yarn evaluate:checkin
yarn evaluate:checkin --verbose
yarn evaluate:checkin --dataset=my-dataset
```

### Future Agents

When you create evaluations for other agents, add similar scripts:

```json
{
  "scripts": {
    "evaluate:back-channel": "NODE_ENV=test node --loader ts-node/esm evaluations/back-channel/runBackChannelEvaluations.ts"
  }
}
```

## Creating Evaluations for a New Agent

Follow these steps to create an evaluation suite for a new agent:

### 1. Create Directory Structure

```bash
mkdir -p evaluations/<agent-name>
```

### 2. Create Configuration File

Create `<agent-name>-config.ts`:

```typescript
import { initializeEvaluators } from '../../tests/utils/evaluators.js'

// Agent-specific custom evaluation prompts (optional)
const correctnessPrompt = `...tailored to agent's purpose...`

// Evaluation types specific to this agent
export const evaluationTypes = {
  semantic: {
    name: 'Semantic Response',
    evaluators: ['correctness', 'hallucination', 'groundedness']
  }
  // ... other types
}

// Initialize evaluators with custom prompts
export async function initializeAgentEvaluators() {
  await initializeEvaluators({
    correctness: correctnessPrompt
  })
}
```

### 3. Create LangSmith Dataset

Create a dataset in LangSmith with test cases including:

- Input text
- Expected outputs (reference answers)
- Metadata ( prompt type, context, etc.)

### 4. Create Evaluation Runner

Create `run<AgentName>Evaluations.ts`:

```typescript
#!/usr/bin/env tsx
import { /* agent-specific imports */ } from '...'
import { /* prompts */ } from './<agent-name>-config.js'

// Setup agent-specific test environment
async function setupAgent(...) {
  // Agent-specific setup
}

// Run evaluations with agent-specific logic
async function runSingleTest(testCase, testConfig) {
  // Agent-specific test execution
}

// Main runner
async function main() {
  // Load config, run tests, report results
}

main()
```

### 5. Add Package.json Script

```json
{
  "scripts": {
    "evaluate:<agent-name>": "NODE_ENV=test node --loader ts-node/esm evaluations/<agent-name>/run<AgentName>Evaluations.ts"
  }
}
```

### 6. Create README

Document agent-specific evaluation types, dataset structure in LangSmith, and usage.

## Best Practices

### Test Case Design

1. **Reference Outputs**: Provide 2-3 varied correct answers (not just one) in LangSmith dataset
2. **Coverage**: Include edge cases and standard cases
3. **Evaluation Types**: Match prompt type (in metadata) to the test case type

### Evaluation Prompts

1. **Specificity**: Tailor prompts to agent's purpose and output format
2. **Rubrics**: Provide clear scoring rubrics with examples
3. **Context**: Include agent-specific context in prompts
4. **Consistency**: Use consistent terminology across prompts

## Customizing Trace Information for Evaluations

To make it easy to add production traces to your evaluation dataset, you can customize how your agent's inputs, outputs, and metadata are logged to LangSmith by implementing optional methods in your agentType definition.

### Why Customize Traces?

By default, LangSmith traces log the full `conversationHistory` and `userMessage` as input, and the complete `responses` array as output. This often contains more information than needed for evaluation. Customizing traces allows you to:

1. **Match Dataset Format**: Ensure production traces have the same structure as evaluation test cases
2. **Simplify Inputs**: Log only the essential input (e.g., just the user's question text)
3. **Simplify Outputs**: Log only the agent's response message, not internal metadata
4. **Add Custom Metadata**: Include evaluation-relevant data like context, prompt type, or conversation history

### Optional Methods

Add these methods to your agentType definition (e.g., in `src/agents/<agent-name>/<agent-name>.ts`):

#### 1. `formatTraceInput(conversationHistory, userMessage)`

Formats the input that will be logged to LangSmith traces.

```typescript
formatTraceInput(conversationHistory, userMessage) {
  // Return just the user's question text instead of the full message object
  return userMessage?.body
}
```

**Default behavior**: Logs `{ conversationHistory, userMessage }` as input

#### 2. `formatTraceOutput(responses)`

Formats the output that will be logged to LangSmith traces.

```typescript
formatTraceOutput(responses) {
  // Return just the response text instead of the full response object
  return responses[0].message
}
```

**Default behavior**: Logs the complete `responses` array as output

#### 3. `getTraceMetadata(conversationHistory, userMessage, responses)`

Returns custom metadata to include in the trace. This is particularly useful for storing evaluation-relevant information.

```typescript
getTraceMetadata(conversationHistory, userMessage, responses) {
  return {
    context: responses[0].context,           // RAG context used
    conversationHistory: conversationHistory, // Full conversation
    channels: userMessage?.channels,          // Where the message came from
    promptType: responses[0]?.promptType      // For evaluation type selection
  }
}
```

**Default behavior**: No custom metadata added

### Complete Example

Here's how the Event Assistant implements all three methods (see `src/agents/eventAssistant/eventAssistant.ts:88-103`):

```typescript
export default verify({
  name: 'Event Assistant',
  // ... other config ...

  formatTraceInput(conversationHistory, userMessage) {
    return userMessage?.body
  },

  formatTraceOutput(responses) {
    return responses[0].message
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      context: responses[0].context,
      conversationHistory,
      channels: userMessage?.channels,
      promptType: responses[0]?.promptType
    }
  }
})
```

### Using Production Traces in Evaluations

With customized traces:

1. **Production traces** are logged to LangSmith with simplified input/output matching your dataset format
2. **Find traces** in LangSmith that you want to add to your evaluation dataset
3. **Add to dataset** directly from LangSmith UI - the format will match your existing test cases
4. **Run evaluations** using the expanded dataset with real production examples

This workflow allows you to continuously improve your evaluation coverage with real-world examples from production.

## Viewing Results

All evaluation results are logged to LangSmith as experiments:

1. Visit: https://smith.langchain.com
2. Each run creates a new experiment project named `<agent-name>__<timestamp>__g<git-sha>`
3. The experiment references the test dataset for comparison
4. View individual test results, evaluator scores, and compare runs over time
5. Filter results using LangSmith's query interface

## FAQ

**Q: Why can't I reuse Event Assistant evaluations for Back Channel?**
A: The evaluation prompts are tailored to EA's Q&A format. BCI generates insights, not answers, so it needs different rubrics and evaluation logic.

**Q: Should I add new test cases to CI tests or evaluation suite?**
A: Add functional assertions to CI tests (classification, structure). Add quality tests to evaluation suite (LangSmith dataset).

**Q: How often should evaluations run?**
A: CI tests run on every commit. Evaluation suites run on-demand during development, nightly for trends, and always before releases.

**Q: Can evaluation suites fail CI?**
A: Not by default. Use them for quality tracking. Only fail CI on critical regressions after manual review.

**Q: What's the difference between evaluation types?**
A: Evaluation types (defined in config) determine which evaluators run. For example, "timewindow" tests use fewer evaluators than "semantic" tests. The type is specified in the LangSmith example metadata as `promptType`.

**Q: Where are test cases stored?**
A: Test cases are stored in LangSmith datasets, not local files. This allows versioning, collaboration, and easy updates without code changes.
