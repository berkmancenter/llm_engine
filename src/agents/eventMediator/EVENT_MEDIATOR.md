# The Event Mediator

## What It Is

An AI agent that monitors private participant messages, shared group chat, and transcript during live events. It detects patterns and makes strategic interventions in the shared space — helping people feel less alone in their questions, surfacing tensions the room isn't acknowledging, and giving the conversation shape and life.

## Intervention Types

The Event Mediator chooses from among these intervention types when evaluating whether to send a message. Several of these interventions surface patterns from private channels into the shared space, requiring access to private messages. Others, such as Bridge and Structure give the conversation shape and continuity. These help participants maintain context and see where things are going.

- **SIGNAL** — Surfaces what the room is privately thinking. Convergence, divergence, or resonance with what's being said on stage. The core function: making invisible patterns visible.
- **SYNTHESIS** — Goes deeper than SIGNAL. Reframes scattered private reactions into a single, richer question nobody individually asked.
- **MINORITY_VOICE** — Protects dissent. When the room appears to agree but private channels say otherwise, creates space for the suppressed perspective without exposing anyone.
- **CONFUSION** — Detects when people are lost. Drops jargon definitions, pace summaries, or flags to the moderator that things are moving too fast.
- **MODERATOR_ESCALATION** — Routes high-interest themes to the moderator with a synthesized question and lets the room know it's been done.
- **BRIDGE** — Connects the present to an earlier moment. Callbacks that create the feeling of an attentive companion: "Told you the infrastructure question wasn't done with us."
- **STRUCTURE** — Chapter markers, section summaries, decision capture. Gives the conversation narrative shape so people can orient.

## Why This Is Interesting

- **It makes private thought collective without breaking privacy.** The hardest design problem here — and the thing that makes it genuinely novel — is that the agent has access to what everyone is privately thinking but can never reveal any individual's contribution. It operates through abstraction: detecting patterns, not relaying messages.
- **It lowers the social cost of participation.** Most people at events have questions they don't ask because they assume they're the only one wondering. This agent tells them they're not alone — which often is enough to get them to speak up.
- **It counteracts groupthink in real time.** MINORITY_VOICE is the most distinctive capability. Public consensus suppresses private doubt in every group setting. This agent can say "the room isn't as aligned as it looks" without anyone having to be the lone dissenter.
- **It gives the conversation a companion, not a narrator.** The two-register design (warm when people are vulnerable, witty when there's breathing room) means the agent feels like a presence in the room rather than a tool. Callbacks and predictions create continuity. Structural interventions give shape without being dry.
- **It knows when to shut up.** Unless engagement is weighted highly, most cycles produce no output. The agent's credibility depends on restraint — every post earns its place, which means silence is the most common and most important decision it makes.
- **The prompt is example-driven, not description-driven.** At ~1400 tokens, the system prompt is compact but rich. Each intervention type is defined primarily by examples that simultaneously teach tone, length, register, and privacy handling — which is more effective than prose descriptions and roughly 60% more token-efficient.
