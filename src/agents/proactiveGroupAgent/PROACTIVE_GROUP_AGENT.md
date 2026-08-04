# The Proactive Group Agent

## What It Is

An AI agent that monitors private participant messages, shared group chat, and transcript during live events. It reads the room — detecting patterns, silences, emotional moments, and conversational dynamics — and makes strategic interventions in the shared group chat when warranted.

Agent behavior is defined by a set of **goals** — declarative JSON files that specify what to watch for, when to hold back, and what to say. Which goals are active at any moment is determined by the conversation's configuration; the agent composes its prompt, schema, and judgment criteria at runtime from whatever is loaded.

The agent runs on a periodic timer (every 120 seconds). How often it posts depends heavily on which goals are active. Facilitative goals require specific patterns to emerge from private signals across multiple participants — most cycles produce nothing. Catalyst goals react to ambient conditions (silence, passive chat, transcript moments) that are frequently true, so a catalyst-heavy configuration will post much more often. The rate limit and minimum confidence threshold are the primary governors in that case.

## Goals

Each goal is a JSON file with: trigger conditions, a minimum confidence threshold, guardrails, an output format (`text` or `poll`), and examples. The active goal set for a conversation is determined by the `goals` field on the conversation model plus the `behaviorPolicy`.

### Facilitative Goals

These goals work with private messages and focus on giving the conversation shape, continuity, and inclusion.

- **surface_signal** — Makes the invisible visible. When multiple participants privately express the same question, concern, or reaction, the agent surfaces it as a collective pattern — without attributing it to anyone. Requires 2+ independent signals before acting.
- **synthesize_discussion** — Goes deeper than surfacing. Reframes scattered threads into a single, richer question that no individual participant had fully formed. Used at natural pauses when multiple distinct conversations have been running in parallel.
- **invite_quieter_voices** — Protects dissent. When the room is converging quickly or public enthusiasm is high, but private channels reveal doubt, the agent makes space for the suppressed perspective without exposing anyone. Always warm in register.
- **clarify_confusion** — Detects when people are lost. Drops jargon definitions and pace summaries when multiple participants signal they're not following.
- **bridge_topics** — Connects the present to an earlier moment in the conversation or transcript. Creates the feeling of an attentive companion who noticed what others didn't.
- **structure_conversation** — Chapter markers, section summaries, decision capture. Gives the conversation narrative shape so participants can orient.

### Catalyst Goals

These goals work primarily from shared chat and transcript. They generate energy, spark discussion, and add personality to the room.

- **provoke_participation** — Asks the question the room needs. Used when participation is low, discussion is one-sided, or the conversation risks stalling. Not used when participants are already actively exchanging substantive messages — a working discussion doesn't need interruption.
- **play_commentary** — Color commentary, predictions, self-aware asides. Pure personality, used sparingly during breathing room — after emotional peaks, during structural transitions, or when something genuinely surprising just happened. The witty friend leaning over to whisper.
- **poll_reveal** — Creates a structured poll to generate energy and collective engagement through the reveal moment itself. Not used when the speaker is already soliciting a structured audience response (show of hands, a vote). See poll mechanics below.

## Behavior Policy

A `behaviorPolicy` on the conversation controls how the agent operates:

- **Initiative level** — `passive` (agent stays silent), `lightlyProactive`, `moderatelyProactive`, `highlyProactive`. Passive skips the agent entirely.
- **Social sensitivity** — `standard` (confidence threshold 60) or `high` (threshold raised to 75 before the agent will post).
- **Min contribution interval** — How many minutes must pass between the agent's own posts. Defaults to 2. A grace buffer equal to the periodic timer period is subtracted from the rate limit check, so a post from the previous cycle never blocks the next one when `minContributionMinutes` matches the timer period.
- **Safety posture** — `standard` or `strict`. When strict, proposed messages are passed through a professionalism validator before being sent.

The effective confidence threshold is `max(policyThreshold, max(goal.triggers.minConfidence))` — the most conservative floor across both layers wins.

## Privacy Rules

- Never quote or closely paraphrase a private message.
- Reference private messages only in aggregate: "several of you," "there's energy around..."
- If only one person raised something privately, do not surface it. Wait for 2+ independent signals, or until it appears publicly.
- Abstract themes so no individual could recognize their own words.
- Exception: a participant explicitly asks the agent to raise something on their behalf — it may do so, but still without attribution.

## How POLL_REVEAL Works

Poll goals are implemented differently from text goals. Rather than generating a chat message, the agent uses a `create_poll` tool (ReAct pattern) to create the poll in the database, then posts a brief intro message to group chat containing the poll reference. The frontend renders this as an inline poll widget.

**Poll configuration:**

| Setting                             | Value  | Rationale                                                        |
| ----------------------------------- | ------ | ---------------------------------------------------------------- |
| `multiSelect`                       | false  | One position per person — forces a genuine choice                |
| `allowNewChoices`                   | false  | Agent defines the options — open choices would dilute the reveal |
| `choicesVisible`                    | true   | Participants see options before voting                           |
| `whenResultsVisible`                | ALWAYS | Results visible immediately — no gate, no wait                   |
| `responsesVisible`                  | true   | Individual responses shown after voting                          |
| `responseCountsVisible`             | true   | Aggregate counts shown                                           |
| `responsesVisibleToNonParticipants` | true   | Non-voters can see results too                                   |
| `defaultExpirationMinutes`          | 3      | Short window — the reveal is meant to happen live                |

The agent generates 2–5 choices that reflect distinct, genuine positions participants might actually hold — not strawmen, not yes/no. The goal is that participants recognize a real position among the options.

## Why This Is Interesting

- **It makes private thought collective without breaking privacy.** The hardest design problem — and the thing that makes it genuinely novel — is that the agent has access to what everyone is privately thinking but can never reveal any individual's contribution. It operates through abstraction: detecting patterns, not relaying messages.
- **Its behavior is configurable without code changes.** Because intervention types are declarative goal files rather than hardcoded agent logic, a conversation can be configured to be purely facilitative, purely catalyst, or any combination. New goal types can be added by writing a JSON file and a test.
- **It lowers the social cost of participation.** Most people at events have questions they don't ask because they assume they're the only one wondering. This agent tells them they're not alone — which is often enough to get them to speak up.
- **It counteracts groupthink in real time.** `invite_quieter_voices` is the most distinctive capability. Public consensus suppresses private doubt in every group setting. This agent can say "the room isn't as aligned as it looks" without anyone having to be the lone dissenter.
- **It knows when to shut up — but only when the goals require it.** Facilitative configurations produce mostly silence because the trigger conditions are specific and private-signal-dependent. Catalyst configurations are intentionally more active — silence during a passive audience is the problem they're designed to solve. In both cases, the JUDGMENT rule is the same: if participants are already actively exchanging substantive messages with each other, stay quiet regardless of goal. A working discussion doesn't need intervention.
- **Confidence gating keeps the bar high.** The agent must exceed a minimum confidence threshold — raised further when social sensitivity is high — before it will post. Goals can set their own floor. The effective threshold is always the most conservative of the two.
