# The Event Mediator

## What It Is

An AI agent that monitors private participant messages, shared group chat, and transcript during live events. It detects patterns and makes strategic interventions in the shared space — helping people feel less alone in their questions, surfacing tensions the room isn't acknowledging, encouraging participation, and giving the conversation shape and life.

## Intervention Categories

Intervention types are organized into 3 categories that can be independently enabled, disabled, and weighted to tune the mediator's behavior:

### **collectiveConsciousness** — Bridge individual experience → group awareness

Contains: SIGNAL, SYNTHESIS, MINORITY_VOICE, CONFUSION, MODERATOR_ESCALATION

- **SIGNAL** — Surfaces what the room is privately thinking. Convergence, divergence, or resonance with what's being said on stage. The core function: making invisible patterns visible.
- **SYNTHESIS** — Goes deeper than SIGNAL. Reframes scattered private reactions into a single, richer question nobody individually asked.
- **MINORITY_VOICE** — Protects dissent. When the room appears to agree but private channels say otherwise, creates space for the suppressed perspective without exposing anyone.
- **CONFUSION** — Detects when people are lost. Drops jargon definitions, pace summaries, or flags to the moderator that things are moving too fast.
- **MODERATOR_ESCALATION** — Routes high-interest themes to the moderator with a synthesized question and lets the room know it's been done.

This surfaces patterns from private channels into the shared space. These interventions require access to private messages to work.

### **engagement** — Generate energy & participation

Contains: PROVOCATION, PLAY

- **PROVOCATION** — Asks the question the room needs. Informed by private signals or room dynamics, designed to give people permission to say what they're thinking.
- **PLAY** — Color commentary, predictions, self-aware asides. Pure personality, used sparingly during breathing room. The witty friend leaning over to whisper.

Interventions that spark discussion and add personality to the room. These work without private messages and focus on activating the conversation.

### **facilitation** — Help people follow along

Contains: STRUCTURE, BRIDGE

- **BRIDGE** — Connects the present to an earlier moment. Callbacks that create the feeling of an attentive companion: "Told you the infrastructure question wasn't done with us."
- **STRUCTURE** — Chapter markers, section summaries, decision capture. Gives the conversation narrative shape so people can orient.

Interventions that give the conversation shape and continuity. These help participants maintain context and see where things are going.

## Configuring Categories

Each category has two controls:

- **`enabled`** (boolean) — Whether the category's interventions are available at all
- **`weight`** (number, 0.0–2.0) — The relative priority of this category's interventions

Default configuration (all categories enabled, equal priority):

```typescript
{
  collectiveConsciousness: { enabled: true, weight: 1.0 },
  engagement: { enabled: true, weight: 1.0 },
  facilitation: { enabled: true, weight: 1.0 }
}
```

### Practical Effects

**Disabling categories:**

- Setting `enabled: false` completely removes that category's interventions from the agent's available options
- If `collectiveConsciousness` is disabled, private messages won't be fetched at all (performance optimization)

**Adjusting weights:**

- Weights create priorities: when multiple intervention types could apply, the agent prefers those from higher-weighted categories
- **weight < 1.0** = LOW priority (use sparingly)
- **weight = 1.0** = NORMAL priority (default)
- **weight ≥ 1.5** = HIGH priority (favor these interventions)

**High engagement mode (weight ≥ 1.5):**

When engagement is weighted at 1.5 or higher, the mediator shifts from observer to active participant. It becomes more proactive about jumping in:

- Responds to unanswered questions from the speaker
- Adds color commentary when something notable happens
- Breaks silence when the room is too quiet
- Challenges bold claims that go unexamined
- Contributes witty observations during natural pauses

This mode gives the mediator permission to participate freely rather than wait for patterns to emerge. The higher the weight, the more present it becomes in the conversation.

### Example Configurations

**Minimal mode** (only surface patterns from private channels):

```typescript
{
  collectiveConsciousness: { enabled: true, weight: 1.0 },
  engagement: { enabled: false, weight: 1.0 },
  facilitation: { enabled: false, weight: 1.0 }
}
```

**High-energy mode** (emphasize participation and personality):

```typescript
{
  collectiveConsciousness: { enabled: true, weight: 0.8 },
  engagement: { enabled: true, weight: 1.8 },
  facilitation: { enabled: true, weight: 1.0 }
}
```

**Structured session** (prioritize continuity and organization):

```typescript
{
  collectiveConsciousness: { enabled: true, weight: 1.0 },
  engagement: { enabled: true, weight: 0.5 },
  facilitation: { enabled: true, weight: 1.6 }
}
```

## Why This Is Interesting

- **It makes private thought collective without breaking privacy.** The hardest design problem here — and the thing that makes it genuinely novel — is that the agent has access to what everyone is privately thinking but can never reveal any individual's contribution. It operates through abstraction: detecting patterns, not relaying messages.
- **It lowers the social cost of participation.** Most people at events have questions they don't ask because they assume they're the only one wondering. This agent tells them they're not alone — which often is enough to get them to speak up.
- **It counteracts groupthink in real time.** MINORITY_VOICE is the most distinctive capability. Public consensus suppresses private doubt in every group setting. This agent can say "the room isn't as aligned as it looks" without anyone having to be the lone dissenter.
- **It gives the conversation a companion, not a narrator.** The two-register design (warm when people are vulnerable, witty when there's breathing room) means the agent feels like a presence in the room rather than a tool. Callbacks and predictions create continuity. Structural interventions give shape without being dry.
- **It can shift from observer to participant.** With high engagement weighting, the agent breaks the fourth wall entirely — jumping into silences, responding to speakers, challenging claims, adding commentary. This isn't a moderator watching from above or a bot following patterns. It's a voice in the room that happens to have access to everyone's private thoughts. The tunable behavior means the same system can either be a quiet pattern-detector or an active conversational presence.
- **It knows when to shut up.** Unless engagement is weighted highly, most cycles produce no output. The agent's credibility depends on restraint — every post earns its place, which means silence is the most common and most important decision it makes.
- **The prompt is example-driven, not description-driven.** At ~1400 tokens, the system prompt is compact but rich. Each intervention type is defined primarily by examples that simultaneously teach tone, length, register, and privacy handling — which is more effective than prose descriptions and roughly 60% more token-efficient.
