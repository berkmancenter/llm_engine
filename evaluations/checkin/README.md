# Checkin Evaluations

LLM-as-judge evaluations for the private DM check-in path of the Event Assistant, covering intervention judgment, goal guardrails, behavior policy compliance, and privacy protection.

## Structure

```
evaluations/
├── templates.ts                    # Shared conversation templates
└── checkin/
    ├── checkinConfig.ts            # Evaluator prompts and registry
    ├── runCheckinEvaluations.ts    # Runner script
    ├── seedDataset.ts              # Seeds starter scenarios into LangSmith
    └── README.md
```

Test cases are stored in a LangSmith dataset named `checkin`.

## Architecture note

Like the Proactive Group Agent suite, this suite spins up a real conversation in the local MongoDB database for each run. Transcript chunks, chat messages, and DMs are inserted into the database and the agent processes them through the normal check-in path (`checkinHandler.ts` → `detectPrivateInterventionOpportunity`).

Running this suite requires a live local database connection. Each run leaves behind test conversations.

## Running

```bash
# Run evaluations against the dataset
yarn evaluate:checkin

# Verbose output (individual evaluator scores + agent reasoning)
yarn evaluate:checkin --verbose

# Use a different dataset
yarn evaluate:checkin --dataset=my-dataset

# Run a single scenario by name
yarn evaluate:checkin --example="private_reassure — classroomLecture — student hedging AI questions"

# Seed starter scenarios into LangSmith
yarn evaluate:checkin:seed

# Preview what would be seeded without writing
yarn evaluate:checkin:seed --dry-run
```

## Evaluators

Eight evaluators run on every example. All are LLM-as-judge with continuous scoring (0.0–1.0). The judge model is always OpenAI (required for tool-calling structured output — Bedrock is not compatible with `openevals`).

| Evaluator | What it checks | Skipped on NO_INTERVENTION? |
|---|---|---|
| `interventionAppropriateness` | Was this the right moment to reach out — or to stay silent? Did the trigger conditions for the chosen goal actually hold? | No |
| `guardrailCompliance` | Does the message respect all goal-level guardrails (e.g. never name other participants, frame as solidarity not rescue)? | Yes |
| `toneCompliance` | Does the message match the tone policy? (clearNeutral / warmSupportive / playful / professional). Content sensitivity overrides playful toward warmth — this is scored as correct. | Yes |
| `formalityCompliance` | Does the language match the formality level? (casual / semiFormal / formal) | Yes |
| `audienceAppropriateness` | Is vocabulary calibrated correctly? Audience profile is a default — individual DM signals take precedence. | Yes |
| `verbosityCompliance` | Does the length match the verbosity policy? (brief / medium / detailed) | Yes |
| `contentSensitivityCompliance` | Does the message respect content sensitivity settings? Scores 1.0 when no sensitivity is set. | Yes |
| `privacyProtection` | Does the message avoid revealing information about other participants? Quoting public transcript or a participant's own words back to them is not a violation. | No |

## Run Outputs

Each LangSmith run records:

| Field | Description |
|---|---|
| `message` | The agent's DM text, or `"NO_INTERVENTION"` |
| `goalId` | The goal the agent selected (e.g. `private_reassure`, `none`) |
| `reasoning` | The agent's internal reasoning from its structured output |
| `confidenceScore` | The agent's self-reported confidence (0–100) |
| `detectedPattern` | Brief description of the pattern the agent detected |

## Dataset Example Format

Each LangSmith example needs:

**Inputs:**
```json
{
  "description": "Short human-readable description of the scenario and expected outcome",
  "goalId": "private_reassure",
  "endTimeSeconds": 380,
  "eventName": "Optional — overrides the default event name",
  "eventDescription": "Optional — overrides the default event description",
  "presenters": [{ "name": "...", "bio": "..." }],
  "transcriptMessages": [
    { "speaker": "Speaker Name", "text": "...", "offsetSeconds": 90 }
  ],
  "chatMessages": [
    { "text": "...", "userIndex": 1, "offsetSeconds": 250 }
  ],
  "participantDms": [
    { "text": "...", "offsetSeconds": 90 }
  ],
  "otherParticipantDms": [
    { "userIndex": 1, "text": "...", "offsetSeconds": 110 },
    { "userIndex": 2, "text": "...", "offsetSeconds": 140 }
  ]
}
```

**Metadata:**
```json
{
  "goalId": "private_reassure",
  "templateName": "classroomLecture",
  "name": "Human-readable name used for deduplication on re-seed",
  "notes": "Optional notes for the scenario"
}
```

**Notes:**
- `userIndex` in all message arrays: `0` = target participant (the one the agent is deciding whether to message), `1` and `2` = other participants.
- `endTimeSeconds` is relative to `startTime = now - 15 minutes`. Must exceed `minContributionMinutes * 60` for the template's DM proactive policy or all participants will be rate-limited before any LLM work.
- `participantDms` are DMs from the target participant to the agent. `otherParticipantDms` are DMs from other participants — required for cross-participant goals (`private_not_alone`, `private_interest_bridge`).
- The `name` in metadata is used to avoid duplicate examples when re-seeding. Rename an example to force a re-seed.
- `goalId` in inputs is used to load the goal's description, trigger conditions, and guardrails for the judge context. It does not constrain which goal the agent picks.

## Templates

Templates are defined in `evaluations/templates.ts` and bundle `goals`, `behaviorPolicy`, and `conversationContext`. All templates include the four private DM goals.

| Name | Tone | Formality | DM initiative | DM social sensitivity | DM min interval |
|---|---|---|---|---|---|
| `publicAcademicLecture` | professional | semiFormal | **passive** | high | — |
| `classroomLecture` | warmSupportive | casual | moderatelyProactive | high | 3 min |
| `companyMeeting` | clearNeutral | semiFormal | lightlyProactive | high | 5 min |
| `publicPanelDiscussion` | warmSupportive | semiFormal | lightlyProactive | medium | 4 min |
| `casualCommunityEvent` | playful | casual | moderatelyProactive | medium | 3 min |

`publicAcademicLecture` has a `passive` DM initiative level — the agent must not send proactive check-ins regardless of trigger conditions. Scenarios using this template that test proactive goals should be marked as expecting `NO_INTERVENTION`.

`socialSensitivity: high` raises the confidence threshold for intervention from 60 to 75.

## Seeded Scenarios

Fourteen scenarios are seeded via `seedDataset.ts`, covering all four private DM goals across multiple templates. Four are deliberate NO_INTERVENTION cases that test suppression conditions rather than message quality.

### private_reassure

| Scenario | Template | Key signal |
|---|---|---|
| Student hedging AI questions | `classroomLecture` | Three hedged DMs — warmSupportive/casual |
| Employee self-minimizing during strategy session | `companyMeeting` | Three hedged DMs with power dynamics — clearNeutral/semiFormal |
| Attendee apologizing for skeptical view | `publicPanelDiscussion` | Three apologetic DMs — warmSupportive/semiFormal |
| **Passive DM policy** | **`publicAcademicLecture`** | **NO_INTERVENTION — initiative level passive** |
| **Single message only** | **`casualCommunityEvent`** | **NO_INTERVENTION — minMessageCount: 3 not met** |

### private_not_alone

| Scenario | Template | Key signal |
|---|---|---|
| Shared "I am behind" feeling across 3 students | `classroomLecture` | Three participants privately share isolation; frame as solidarity |
| Shared safety concern across 3 residents | `casualCommunityEvent` | Sensitive topic — warm register overrides playful |
| **No cross-participant evidence** | **`companyMeeting`** | **NO_INTERVENTION — trigger condition not met** |

### private_interest_bridge

| Scenario | Template | Key signal |
|---|---|---|
| Shared curiosity about junior employee experience | `publicPanelDiscussion` | Three participants privately curious about same unaddressed angle |
| Shared questions about pregnancy loss provision | `companyMeeting` | Highly sensitive topic — strict safety posture; clearNeutral/semiFormal |
| **Only target curious** | **`classroomLecture`** | **NO_INTERVENTION — trigger condition not met** |

### private_transcript_hook

| Scenario | Template | Key signal |
|---|---|---|
| Dense mRNA content, silent participant | `publicAcademicLecture` | **NO_INTERVENTION — initiative level passive** |
| Dense restructure announcements, silent participant | `companyMeeting` | Nine announcements including redundancies; other participants reacting; target completely silent |
| Sparse intro content | `casualCommunityEvent` | **NO_INTERVENTION — density event condition fails** |
