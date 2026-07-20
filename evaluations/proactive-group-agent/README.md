# Proactive Group Agent Evaluations

LLM-as-judge evaluations for the Proactive Group Agent, covering behavior policy compliance, audience appropriateness, content sensitivity, and intervention judgment.

## Structure

```
evaluations/
├── templates.ts                          # Shared conversation templates
└── proactive-group-agent/
    ├── proactiveGroupAgentConfig.ts      # Evaluator prompts and registry
    ├── runProactiveGroupAgentEvaluations.ts  # Runner script
    ├── seedDataset.ts                    # Seeds starter scenarios into LangSmith
    └── README.md
```

Test cases are stored in a LangSmith dataset named `proactive-group-agent`.

## Architecture note

Unlike the Event Assistant evaluation suite — which reconstructs agent context entirely from data embedded in each dataset example — this suite spins up a real conversation in the local MongoDB database for each run. Transcript chunks are loaded into the database and the agent queries them via the normal RAG path.

This means running this suite requires a live local database connection, and each run leaves behind test conversations. It also means scenarios cannot be evaluated from a cold dataset alone — they need the full application stack.

The longer-term goal is to support evaluating examples captured from actual event traces (the same approach the EA suite uses), so that production conversations can be replayed without the database dependency. Until then, scenario inputs are designed to be self-contained enough to reconstruct the relevant state locally.

## Running

```bash
# Run evaluations against the dataset
yarn evaluate:proactive-group-agent

# Verbose output (individual evaluator scores + agent reasoning)
yarn evaluate:proactive-group-agent --verbose

# Use a different dataset
yarn evaluate:proactive-group-agent --dataset=my-dataset

# Run a single scenario by name
yarn evaluate:proactive-group-agent --example="Classroom lecture — quiet after emotionally resonant moment"

# Seed starter scenarios into LangSmith
yarn evaluate:proactive-group-agent:seed

# Preview what would be seeded without writing
yarn evaluate:proactive-group-agent:seed --dry-run
```

## Evaluators

Six evaluators run on every example. All are LLM-as-judge with continuous scoring (0.0–1.0). The judge model is always OpenAI (required for tool-calling structured output — Bedrock is not compatible with `openevals`).

| Evaluator | What it checks |
|---|---|
| `toneCompliance` | Does the message match the tone policy? (clearNeutral / warmSupportive / playful / professional). The agent runs a "sarcastic-expert" personality modifier — the evaluator accounts for wit/brevity on top of the base tone, and only penalises if the personality actively undermines it. |
| `formalityCompliance` | Does the language match the formality level? (casual / semiFormal / formal) |
| `audienceAppropriateness` | Is vocabulary and assumed background knowledge right for this audience? |
| `verbosityCompliance` | Does the length match the verbosity policy? (brief / medium / detailed) |
| `contentSensitivityCompliance` | Does the message respect content sensitivity settings? Scores 1.0 when no sensitivity is set. |
| `interventionAppropriateness` | Was this the right moment to post — or to stay silent? |

## Run Outputs

Each LangSmith run records:

| Field | Description |
|---|---|
| `message` | The agent's posted message, or `"NO_INTERVENTION"` |
| `goalId` | The goal the agent selected (e.g. `invite_quieter_voices`, `none`) |
| `reasoning` | The agent's internal reasoning from its structured output |
| `confidenceScore` | The agent's self-reported confidence (0–100) |
| `detectedPattern` | Brief description of the pattern the agent detected |

## Dataset Example Format

Each LangSmith example needs:

**Inputs:**
```json
{
  "description": "Short human-readable description of the scenario",
  "endTimeSeconds": 450,
  "eventName": "Optional — overrides the default part-time work event",
  "eventDescription": "Optional — overrides the default event description",
  "presenters": [{ "name": "...", "bio": "..." }],
  "transcriptMessages": [
    { "speaker": "Speaker Name", "text": "...", "offsetSeconds": 90 }
  ],
  "chatMessages": [
    { "text": "...", "userIndex": 0, "offsetSeconds": 415 }
  ],
  "privateMessages": [
    { "text": "...", "userIndex": 1, "offsetSeconds": 430 }
  ],
  "contentSensitivity": {
    "level": "elevated",
    "domains": ["mental health", "contested historical claims"]
  }
}
```

**Metadata:**
```json
{
  "templateName": "classroomLecture",
  "name": "Human-readable name used for deduplication on re-seed",
  "notes": "Optional notes for the scenario"
}
```

`templateName` must be one of: `publicAcademicLecture`, `classroomLecture`, `companyMeeting`, `publicPanelDiscussion`, `casualCommunityEvent`.

**Notes:**
- `transcriptMessages` is optional. If omitted, the runner uses the default part-time work fixture.
- `contentSensitivity` is optional. When absent or `level: "standard"`, `contentSensitivityCompliance` defaults to 1.0. Domains are free-form strings.
- The `name` in metadata is used to avoid duplicate examples when re-seeding.

## Templates

Templates are defined in `evaluations/templates.ts` and bundle `goals`, `behaviorPolicy`, and `conversationContext`. They mirror what will be set at event creation time.

| Name | Event type | Audience | Tone | Formality | Verbosity | Initiative |
|---|---|---|---|---|---|---|
| `publicAcademicLecture` | Academic lecture | Expert researchers | professional | semiFormal | brief | lightlyProactive |
| `classroomLecture` | Classroom lecture | Beginner students | warmSupportive | casual | medium | moderatelyProactive |
| `companyMeeting` | Company meeting | Mixed employees | clearNeutral | semiFormal | brief | lightlyProactive |
| `publicPanelDiscussion` | Panel discussion | General public | warmSupportive | semiFormal | brief | moderatelyProactive |
| `casualCommunityEvent` | Community event | General public | playful | casual | medium | moderatelyProactive |

Subject matter and content sensitivity are specified per scenario, not per template — the same template can carry different sensitivity overlays.

## Seeded Scenarios

Nine scenarios are seeded via `seedDataset.ts`. Several are deliberately paired: the same discussion topic run under two different templates, so LangSmith side-by-side comparison directly validates that tone and register shift as expected.

| Scenario | Template | Subject | Key signal |
|---|---|---|---|
| Passive moment after jargon-heavy section | `publicAcademicLecture` | AI & education | Professional/semiFormal; jargon tolerance; elevated content sensitivity |
| **AI jargon confusion** | **`classroomLecture`** | **AI & education** | **Paired with above — warmSupportive/casual/medium contrast** |
| Quiet after emotionally resonant moment | `classroomLecture` | Mental health | Warmth; casual register; sensitive private signals |
| **Burnout session** | **`companyMeeting`** | **Mental health** | **Paired with above — clearNeutral/semiFormal/strict contrast** |
| RTO policy with suppressed junior concerns | `companyMeeting` | Return-to-office | Neutral register; power dynamics; strict safety |
| Public optimism masking private scepticism | `publicPanelDiscussion` | Climate policy | Surface dissent; medium sensitivity |
| Surprising housing stat | `casualCommunityEvent` | Local housing | Playful register; play_commentary opening |
| Active healthy debate | `publicPanelDiscussion` | Climate policy | NO_INTERVENTION |
| **Active community banter** | **`casualCommunityEvent`** | **Local housing** | **NO_INTERVENTION — tests playful template does not over-trigger** |

Specific behavioral assertions (2+ signal threshold, `play_commentary` firing conditions, etc.) are owned by integration tests, not this suite.
