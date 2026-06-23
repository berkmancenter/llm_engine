# The Engagement Agent

## What It Is

An AI agent that monitors shared group chat and transcript during live events. It detects patterns and makes strategic interventions in the shared space — generating energy and encouraging participation. This agent is an active participant in the conversation, jumping in to:

- Respond to unanswered questions from the speaker
- Add color commentary when something notable happens
- Break silence when the room is too quiet
- Challenge bold claims that go unexamined
- Contribute witty observations during natural pauses

## Intervention Types

The Engagement Agent chooses from among these intervention types when evaluating whether to send a message. These interventions spark discussion and add personality to the room. These work without private messages and focus on activating the conversation.

- **PROVOCATION** — Asks the question the room needs. Informed by private signals or room dynamics, designed to give people permission to say what they're thinking.
- **PLAY** — Color commentary, predictions, self-aware asides. Pure personality, used sparingly during breathing room. The witty friend leaning over to whisper.
- **POLL_REVEAL** — Creates a structured poll to generate energy and collective engagement through the reveal moment itself. The poll mechanic — watching votes accumulate in real time — is the intervention. Used when a well-chosen question would get the room active and make the collective view visible. Not used when the speaker is actively soliciting a structured audience response (show of hands, a vote, humming) — that is their moment. Unlike PROVOCATION, POLL_REVEAL produces structured data and a reveal moment rather than open discussion.

### How POLL_REVEAL works

POLL_REVEAL is implemented differently from the other intervention types. Rather than generating a chat message directly, the agent uses a `create_poll` tool (ReAct pattern) to create the poll in the database, then posts a brief intro message to the group chat containing the poll reference. The front end renders this as an inline poll widget within the agent's message.

**Poll configuration for POLL_REVEAL:**

| Setting                             | Value  | Rationale                                                           |
| ----------------------------------- | ------ | ------------------------------------------------------------------- |
| `multiSelect`                       | false  | One position per person — forces a genuine choice                   |
| `allowNewChoices`                   | false  | Agent defines the options — open choices would dilute the reveal    |
| `choicesVisible`                    | true   | Participants see options before voting                              |
| `whenResultsVisible`                | ALWAYS | Results visible immediately — no threshold gate, no expiration wait |
| `responsesVisible`                  | true   | Individual responses shown after voting                             |
| `responseCountsVisible`             | true   | Aggregate counts shown                                              |
| `responsesVisibleToNonParticipants` | true   | Non-voters can see the results too                                  |
| `defaultExpirationMinutes`          | 3      | Short window — the reveal is meant to happen during the live event  |

**Choosing poll choices:** The agent is instructed to generate 2–5 choices that reflect distinct, genuine positions participants might actually hold — not strawmen, not yes/no. The goal is that participants recognize a real position among the options.

## Why This Is Interesting

- **It is an active participant, rather than an observer.** This agent breaks the fourth wall entirely — jumping into silences, responding to speakers, challenging claims, adding commentary. This isn't a moderator watching from above or a bot following patterns. It's a voice in the room that happens to have access to everyone's private thoughts. The tunable behavior means the same system can either be a quiet pattern-detector or an active conversational presence.
