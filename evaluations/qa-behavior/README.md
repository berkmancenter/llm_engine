# QA Behavior Policy Evaluations

LLM-as-judge evaluations for the Event Assistant's Q&A behavior policy, covering how well the agent follows `qaBehavior` configuration across five dimensions: response length, answer scope, clarification handling, context scaffolding, and follow-up dialogue.

## Structure

```
evaluations/
├── templates.ts                      # Shared conversation templates
└── qa-behavior/
    ├── behaviorPolicyConfig.ts       # Evaluator registry and judge context builder
    ├── runQABehaviorPolicyEvaluations.ts  # Runner script
    ├── seedDataset.ts                # Seeds starter scenarios into LangSmith
    └── README.md
```

Test cases are stored in a LangSmith dataset named `qa-behavior`.

## Architecture note

Like the checkin and proactive-group-agent suites, this suite spins up a real conversation in the local MongoDB database for each run. Transcript chunks and chat messages are inserted into the database, and the agent processes the participant DM through the normal Q&A path (`eventQuestionHandler`).

Running this suite requires a live local database connection and access to Chroma for RAG. Each run leaves behind test conversations.

The runner sets `agent.conversationHistorySettings.endTime` to the simulated event time so the live transcript search window is anchored to the scenario, not the current clock.

## Running

```bash
# Run evaluations against the dataset
yarn evaluate:qa-behavior

# Verbose output (individual evaluator scores + judge comments)
yarn evaluate:qa-behavior --verbose

# Use a different dataset
yarn evaluate:qa-behavior --dataset=my-dataset

# Filter to a single example by name
yarn evaluate:qa-behavior --example="responseLength — companyMeeting (short) — What is the Flex3 policy?"

# Filter to all examples for one dimension
yarn evaluate:qa-behavior --dimension=clarifyWhenAmbiguous

# Seed starter scenarios into LangSmith
yarn evaluate:qa-behavior:seed

# Preview what would be seeded without writing
yarn evaluate:qa-behavior:seed --dry-run
```

## Evaluators

Five evaluators run on every example. All are LLM-as-judge with continuous scoring (0.0–1.0). The judge model is always OpenAI (required for tool-calling structured output — Bedrock is not compatible with `openevals`).

| Evaluator | Dimension | What it checks |
|---|---|---|
| `responseLengthCompliance` | `responseLength` | Does the response length match the configured tier? (`short` = 1–2 sentences, `medium` = focused paragraph, `long` = multiple paragraphs). A clarifying question always counts as short. |
| `answerScopeCompliance` | `answerScope` | Does the answer stay within the configured scope? (`helpUserUnderstandTheLecture`, `broaderSubjectArea`, `companyContextOnly`, `open`). Penalises scope violations and missed opportunities. |
| `clarifyWhenAmbiguousCompliance` | `clarifyWhenAmbiguous` | When the question is genuinely ambiguous: does the agent ask for clarification (`true`) or pick a reasonable interpretation (`false`)? Unambiguous questions score 1.0 regardless of the setting. |
| `addContextWhenUsefulCompliance` | `addContextWhenUseful` | When `true`: does the agent add analogies or scaffolding for a novice audience rather than a bare answer? When `false`: does the agent answer directly without unsolicited explanatory padding? |
| `followUpDialogueCompliance` | `allowFollowUpDialogue` | When `true`: does the agent close with a genuine invitation to continue the conversation? When `false`: does the agent close cleanly without signalling openness to further dialogue? |

Evaluator prompts are defined in `behaviorPolicyConfig.ts` alongside the evaluator registry.

## Run Outputs

Each LangSmith run records:

| Field | Description |
|---|---|
| `message` | The agent's DM response text, or `"NO_RESPONSE"` |
| scores (as feedback) | One score per evaluator (0.0–1.0) with judge comment |

## Dataset Example Format

Each LangSmith example needs:

**Inputs:**
```json
{
  "description": "Short human-readable description of the scenario",
  "userQuestion": "The participant's DM to the agent",
  "dimension": "Which qaBehavior dimension this tests",
  "endTimeSeconds": 310,
  "eventName": "Optional — overrides default",
  "eventDescription": "Optional — overrides default",
  "presenters": [{ "name": "...", "bio": "..." }],
  "transcriptMessages": [
    { "speaker": "Speaker Name", "text": "...", "offsetSeconds": 90 }
  ],
  "chatMessages": [
    { "text": "...", "userIndex": 0, "offsetSeconds": 250 }
  ]
}
```

**Metadata:**
```json
{
  "templateName": "classroomLecture",
  "dimension": "responseLength",
  "name": "Human-readable name used for deduplication on re-seed",
  "notes": "Optional notes about what to expect"
}
```

`templateName` must be one of: `publicAcademicLecture`, `classroomLecture`, `companyMeeting`, `publicPanelDiscussion`, `casualCommunityEvent`.

**Notes:**
- `endTimeSeconds` is relative to `startTime = now - 15 minutes`. It controls both the conversation history window and the live transcript search window.
- `chatMessages` with `userIndex: 0` are from the participant sending the DM. Higher indices are other participants.
- The `name` in metadata is used to avoid duplicate examples when re-seeding. Rename an example to force a re-seed.
- `dimension` is used for CLI filtering (`--dimension=...`) and LangSmith display only. It is not passed to the judge — each evaluator's prompt defines its own scope.

## Templates

Templates are defined in `evaluations/templates.ts` and set the full `behaviorPolicy` including `qaBehavior` for the DM channel. Each template configures a specific combination of values across all five dimensions.

| Template | `responseLength` | `answerScope` | `clarifyWhenAmbiguous` | `addContextWhenUseful` | `allowFollowUpDialogue` |
|---|---|---|---|---|---|
| `publicAcademicLecture` | medium | broaderSubjectArea | false | true | true |
| `classroomLecture` | medium | helpUserUnderstandTheLecture | true | true | true |
| `companyMeeting` | short | companyContextOnly | false | false | false |
| `publicPanelDiscussion` | medium | broaderSubjectArea | false | true | true |
| `casualCommunityEvent` | short | open | false | false | false |

## Seeded Scenarios

Eleven scenarios are seeded via `seedDataset.ts`, covering all five dimensions across multiple templates. Most dimensions are paired across two templates with opposing policy values so LangSmith side-by-side comparison directly shows whether the agent's behaviour shifts as configured.

### responseLength

| Scenario | Template | Expected behaviour |
|---|---|---|
| What is the Flex3 policy? | `companyMeeting` | 1–2 sentence answer (`short`) |
| What is gradient descent? | `classroomLecture` | Focused paragraph (`medium`) |

### answerScope

| Scenario | Template | Expected behaviour |
|---|---|---|
| How does ML work? (employee) | `companyMeeting` | Redirect to company context only |
| How does ML work? (academic) | `publicAcademicLecture` | Broad ML explanation permitted |
| Is AI news related to today? | `classroomLecture` | Connect to lecture; do not drift |
| Python for data analysis (off-topic) | `casualCommunityEvent` | Engage — `open` scope permits it |

### clarifyWhenAmbiguous

| Scenario | Template | Expected behaviour |
|---|---|---|
| "I got lost with that last thing" | `classroomLecture` | Ask which concept they mean |
| "I got lost with that last thing" | `casualCommunityEvent` | Make a reasonable interpretation and answer |

### addContextWhenUseful

| Scenario | Template | Expected behaviour |
|---|---|---|
| "What's a loss function?" (novice) | `classroomLecture` | Analogy or scaffolding alongside the definition |
| When does the home-office stipend apply? | `companyMeeting` | Direct answer — no unsolicited background |

### allowFollowUpDialogue

| Scenario | Template | Expected behaviour |
|---|---|---|
| Key takeaways from the panel? | `publicPanelDiscussion` | Close with a genuine follow-up invitation |
| Main takeaways from today? | `companyMeeting` | Clean close — no invitation to continue |
