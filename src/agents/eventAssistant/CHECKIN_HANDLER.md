# Private Check-in Handler

## What It Is

A component of the Event Assistant that runs periodically during live events, scanning each participant's private DM history and deciding whether to proactively reach out. Unlike the Event Assistant's Q&A mode (which responds to what participants ask), the check-in handler acts on patterns — things the participant hasn't said directly but that their messages reveal over time.

Every message a participant sends in DMs receives a direct Q&A response. The check-in handler is for what those responses can't cover: the accumulation of hesitation across a conversation, the social isolation of feeling like the only doubter in the room, or the silence of someone who got left behind by a fast-moving section.

## Check-in Types

The handler chooses from among these types, or sends nothing. Most cycles produce nothing — silence is the default.

- **SOCIAL_REASSURANCE** — Detects a *pattern* of hesitation, self-minimization, or dissent across a participant's own messages and names it warmly. The goal is to normalize their way of showing up and reduce self-censorship. Requires at least 3 participant messages showing the pattern — never fires on fewer, since the Q&A response already addressed each individual message.

- **NOT_ALONE** — Sends when other participants are privately expressing the same doubt or hesitation as this one. Tells them their reaction is shared, not unique, without naming anyone or revealing specifics. Requires verified cross-participant evidence (`sourceMessages`). Can trigger on a single message from the target if the cross-participant signal is clear.

- **INTEREST_BRIDGE** — Lets a participant know others are privately asking about the same topic. About shared curiosity, not shared anxiety. Requires the participant to have sent at least one DM (so there's a topic to bridge to) and cross-participant evidence of shared interest.

- **TRANSCRIPT_HOOK** — After a dense or fast-moving transcript section, reaches out to a participant who has been quiet during that section. Names a specific topic and removes the burden of question formation. Never sends a generic "things moved fast" message. Determined by a single shared LLM evaluation per cycle — not repeated per participant.

- **NONE** — No message needed. The most common outcome.

## Why SOCIAL_REASSURANCE and NOT_ALONE Are Distinct

Both are about reassurance, but they differ in trigger, evidence, and message:

| | SOCIAL_REASSURANCE | NOT_ALONE |
|---|---|---|
| **Trigger** | Participant's own pattern across 3+ messages | Cross-participant shared doubt/hesitation |
| **Evidence required** | Pattern in this participant's DM history | Verified `sourceMessages` from other participants |
| **Can fire on single message?** | No | Yes, if cross-participant signal is strong |
| **Message addresses** | Their own recurring pattern | That they are not alone in the room |
| **`sourceMessages` used?** | Never | Always |

## Eligibility Gating

Before the LLM is called for a participant, each type is checked for eligibility. If no types are eligible, the LLM call is skipped entirely.

| Type | Eligible when |
|---|---|
| SOCIAL_REASSURANCE | Participant has sent ≥3 DMs |
| NOT_ALONE | Participant has sent ≥1 DM, and at least one other participant has sent a DM |
| INTEREST_BRIDGE | Participant has sent ≥1 DM, and at least one other participant has sent a DM |
| TRANSCRIPT_HOOK | Transcript density LLM evaluation (shared, runs once per cycle) returns dense=true, AND participant has been quiet during the density window |

Only eligible types appear in the system prompt and schema — the LLM never sees types it can't use.

## Shared Evaluations

Some check-in types require expensive determinations that would be wasteful to repeat per participant. These run once before the participant loop via `evaluateShared`, and results are passed to each participant's `isEligible` check.

Currently: **TRANSCRIPT_HOOK** runs a single LLM call to determine whether the recent transcript was dense or fast-moving, and which topic was covered. This result is reused across all 50 participants in the cycle.

This pattern extends naturally to future types that need shared context.

## Hallucination Prevention

Any message that implies others share a sentiment (NOT_ALONE, INTEREST_BRIDGE) requires the LLM to populate `sourceMessages` — an array of `{participant, text}` pairs. Before sending, the handler verifies each cited pair against actual messages using fuzzy matching (≥70% on both pseudonym and text). If verification fails, the message is suppressed. This mirrors the backChannel hallucination filter and prevents fabricated social proof.

`sourceMessages` is a server-side audit field — it is never shown to the recipient.

## Configuration (`agentConfig`)

| Property | Default | Description |
|---|---|---|
| `checkinScanInterval` | `3` (minutes) | How often the handler runs and the transcript density window |
| `minInterval` | `10` (minutes) | Minimum time between check-ins to the same participant |

`checkinScanInterval` controls three things in sync: the timer period, the transcript lookback window for density evaluation, and the quiet window used to determine whether a participant has been silent during the dense section.

## SOCIAL_REASSURANCE: Signals

The handler looks for accumulation of these signals across at least 3 messages:

- Repeatedly apologizing for or minimizing their own contribution before making it
  - *"Sorry if this is obvious, but..."*
  - *"I'm probably wrong but..."*
  - *"Not sure this is worth asking, but..."*

- Asking whether they're the only one feeling a certain way
  - *"Is it just me or does this feel underdeveloped?"*
  - *"Am I the only one who finds this idealistic?"*
  - *"Does anyone else feel like this only works in certain industries?"*

- Keeping their own experience at arm's length, describing it in the third person
  - *"Some people might feel..."*
  - *"I could imagine someone thinking..."*

- Going quiet or pulling back after a point of friction or pushback
  - Confident dissent followed by progressive retreat: *"I disagree"* → *"maybe I'm wrong about that"* → *"never mind, probably not worth getting into"*

- Stacking multiple qualifiers in a single message in a way that suggests it almost didn't get sent
  - *"I'm not sure, maybe, probably, I could be wrong, but..."*

## SOCIAL_REASSURANCE: Example Messages

*(Pattern of self-minimization)*
> "The questions you keep almost not sending are usually the most worth asking."

*(Recurring dissent or skepticism)*
> "Keeping a running doubt alive across a whole conversation usually means you're onto something. That's worth staying with."

*(Pulling back after friction)*
> "If something landed sideways, you don't have to frame it as a question — one word is enough."

*(General pattern of hedging)*
> "Nothing here requires certainty. Uncertainty usually means you're paying close attention."

## NOT_ALONE: Example Messages

> "A few others are privately sitting with similar questions — you're in good company."

> "You're not the only one circling that. Others are privately sitting with something similar, even if it's not coming up in the main chat."

> "That hesitation is more common in this room than you might think."

## INTEREST_BRIDGE: Signals

The handler looks for a topic that multiple participants are privately asking about, independently. Shared curiosity — not shared anxiety. The goal is to let each participant know their interest isn't isolated, without revealing who else is asking or what they said.

- Multiple participants asking different-but-convergent questions about the same area
  - *"How does compensation parity actually work?"* / *"Are part-time roles paid proportionally?"* / *"What about salary bands?"*
- A participant expressing genuine interest or wanting to go deeper on a topic that others are privately exploring
  - *"I'd love to know more about the handoff design piece"* paired with others asking similar follow-ups

The message names the shared topic area in general terms — it never quotes or closely paraphrases another participant's words.

The LLM must populate `sourceMessages` with the specific messages that establish cross-participant interest. These are verified before sending.

## INTEREST_BRIDGE: Example Messages

*(Multiple participants privately asking about compensation parity)*
> "A few people have been privately asking about compensation structures — seems like it's resonating beyond what's come up in the main chat."

*(Shared curiosity about a specific framework)*
> "You're not the only one thinking about the handoff design piece. There's more interest in that than the conversation has had space for."

> "Several people are privately exploring the same topic. Might come up in Q&A, or happy to dig into it here."

## TRANSCRIPT_HOOK: Example Messages

*(After a dense section on five job-design frameworks)*
> "We just moved through a lot on scope compression and handoff design. Happy to go deeper, make connections, or just sit with any part of it — no need to phrase it as a question."

> "That compensation parity section moved fast. If anything in there didn't land, just point me at it — one word is enough."

## Design Principles

- **Pattern, not instance.** The Q&A loop handles individual messages. Check-ins are for what the Q&A loop can't see: the accumulation across a conversation.
- **Neurodiversity-affirming.** Every question is worth asking. Hesitation and dissent are signs of careful attention, not deficiency. Messages never imply the participant is doing something wrong.
- **Privacy-preserving by design.** The handler sees all participants' DMs but never reveals any individual's contribution. Cross-participant signals are surfaced only through abstraction — "others are sitting with something similar" — never by quoting or hinting at specific messages.
- **Restraint is the default.** Most cycles produce nothing. The handler's credibility depends on not over-messaging. A second check-in is suppressed until `minInterval` minutes have passed since the last one.
- **Rate limiting is per-participant.** The interval check is scoped to each participant's own DM channel, not the shared chat — so one participant receiving a check-in doesn't block another from receiving one.
- **LLM calls are skipped when nothing is eligible.** Eligibility gating means a participant who has never messaged and is in a sparse-transcript cycle never incurs an LLM call.
