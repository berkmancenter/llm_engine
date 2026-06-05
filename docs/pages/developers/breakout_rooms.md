# Breakout Rooms: Architecture & Implementation Plan

Status: Proposed (branch `jh/breakouts`)

This document describes how breakout-room support is added to the LLM Engine. It
covers the requirements, the architecture decisions (and the alternatives that
were discarded and why), and a concrete, step-by-step implementation plan with
file references.

---

## 1. Requirements

1. Each breakout room has the context of the parent (main) session, but **not**
   the context of the other simultaneous breakout rooms.
2. When breakouts close and the group reconvenes, the follow-up combined session
   has the **full** context of the initial main session **and** all breakout
   sessions, with each breakout's content **distinguishable**.
3. Generic breakout handling lives in **core** (so future adapters can have
   breakouts); Zoom/Recall-specific orchestration lives in **adapters/handlers**.
4. Breakouts can have a **name** and (optionally) a **description**.
5. Support **N breakout rooms simultaneously**, and **multiple breakout rounds
   sequentially** over the life of a session.

---

## 2. Relevant existing architecture

A short map of the pieces this feature builds on (verified in the codebase):

- **Conversation** owns `channels`, `agents`, and `adapters`
  (`src/models/conversation.model.ts`, `IConversation` in
  `src/types/index.types.ts`).
- **Channel** is a lightweight doc: `name`, `passcode`, `direct`, `participants`
  (`src/models/channel.model.ts`). Messages are tagged with channel **name
  strings** (`src/models/message.model.ts`).
- **Context assembly** is an allow-list filter over channels:
  `getConversationHistory(messages, settings)` filters by
  `settings.channels` / `directMessages` / `count` / `timeWindow`
  (`src/agents/helpers/getConversationHistory.ts`). Settings come from the
  agent's `conversationHistorySettings` or per-trigger overrides, resolved in
  `Agent.respond()` (`src/models/user.model/agent.model/index.ts`).
- **Adapters** translate a platform to internal messages; **handlers** are the
  webhook HTTP ingress. The Zoom adapter (`src/adapters/zoom.ts`) deploys a
  **Recall.ai** bot; Recall webhooks land in `src/handlers/recall.ts`.
- **Crucially:** multiple Zoom bots per conversation are *already* supported.
  `src/handlers/recall.ts` resolves the adapter by matching `botId` among
  `conversation.adapters` (line ~153), and `zoom.ts` already iterates multiple
  zoom adapters on one conversation (`participantJoined`, line ~400).
- **Recall breakout model**: one bot per room. A coordinator bot
  (`breakout_room.mode: join_main_room`) stays in the main room and receives
  `bot.breakout_room_opened` / `bot.breakout_room_closed`. A per-room bot
  (`mode: join_specific_room`, `room_id`) records a single room. Webhooks carry
  a normalized `room.id` and `room.name`. Requires Zoom's "Let participants
  choose room" setting.

---

## 3. Architecture decisions

### Decision A — Topology: one conversation, breakout room = scoped channels

A breakout round creates, **within the same conversation**, a set of channels
per room (a transcript channel and a chat channel), each tagged with a breakout
marker. Context isolation and reconvene are then expressed purely through the
existing channel allow-list filter.

- A room agent's context allow-list = `[parent channels] + [its own room
  channels]`. Sibling rooms are excluded simply by not being on the list
  (Requirement 1).
- On reconvene, the main agent's allow-list expands to include all breakout
  channels, so it sees everything, labeled per room (Requirement 2).
- Sequential rounds = new `roundId` per open; prior rounds' channels persist
  (inactive) and remain available to the reconvened context (Requirement 5).
- N simultaneous rooms = N per-room bots = N extra zoom adapter docs on the same
  conversation, which the webhook layer already routes by `botId`.

**Why this topology:** the reconvene requirement is the deciding factor. In one
conversation, all messages already coexist and are filtered by channel, so
"combined, distinguishable context" is essentially free and reuses
`getConversationHistory`. It also matches the code as-is (multi-bot routing by
`botId`, channels as routing labels).

#### Discarded: each breakout room as a separate child conversation

Rejected. Each Recall bot maps cleanly to its own conversation, and sibling
isolation would be automatic — but it makes the two hardest requirements harder,
not easier:

- **Seeding parent context into a child** would require copying or
  cross-reading the parent's messages into each child conversation. No
  cross-conversation context mechanism exists today.
- **Reconvene** would require aggregating messages from N child conversations
  back into the parent's LLM context, distinguishably — again a brand-new
  cross-conversation capability, plus cross-conversation transcript/RAG search.
- It duplicates transcript handling (`ITranscript` and the RAG collection are
  per-conversation) across many short-lived conversations.

In short, child conversations optimize for isolation (which channels already
give us) at the cost of the aggregation we actually need.

#### Discarded: a dedicated `Breakout`/`BreakoutRoom` Mongoose collection

Rejected as the primary store. A separate collection would duplicate the
room→channel→round→agent relationships that channels + a marker already express.
Instead, breakout channels (channels carrying a `breakout` marker) are the
**source of truth**; rounds are derived by grouping on `roundId`. This keeps the
data model small and reuses channel auth/routing/queries. (If a richer breakout
entity is ever needed, it can be introduced later without changing the channel
contract.)

### Decision B — Context scoping primitive: `includeBreakouts` flag

Room agents get an explicit channel allow-list at spawn time, so **no new
primitive is needed for isolation**. The only dynamic case is the main agent
needing to pull in breakout channels that did not exist when it was configured.
We add `includeBreakouts?: 'none' | 'all'` to `ConversationHistorySettings`
(default `none`) and resolve it in `Agent.respond()` (where the populated
conversation/channels are available) by expanding `settings.channels` before
calling `getConversationHistory`.

- `none` (default): breakout content is excluded from the main agent during a
  live round.
- `all`: breakout channels are merged in for the reconvened combined session.

**Why here:** it keeps `getConversationHistory` a pure function (it already only
knows about a flat message list + settings) and localizes breakout awareness to
`respond()`, which already does channel resolution.

#### Discarded: a generic `excludeChannels` blocklist

Rejected. A blocklist would require every agent to know the (dynamic) set of
breakout channels to avoid, inverting the existing allow-list model and leaking
breakout knowledge into unrelated agents. The allow-list + `includeBreakouts`
expansion keeps breakout logic in one place.

### Decision C — Where breakout configuration lives: `agentConfig.breakout`

Breakout configuration is an optional nested block on the **coordinator** agent
type (e.g. `eventAssistant`):

```jsonc
agentConfig: {
  breakout: {
    enabled: false,            // gate the coordinator into join_main_room mode
    agentType: 'eventAssistant', // agent type spawned per room (default: same)
    agentConfig: { /* overrides applied to each spawned room agent */ },
    historySettings: { /* base conversationHistorySettings for room agents */ },
    namePrefix: 'Breakout',    // optional naming convention
    rooms: [                   // optional pre-declared enrichment, matched by name
      { name: 'Room 1', description: '...' }
    ]
  }
}
```

**Why `agentConfig`:** it matches the established nested-config pattern
(`delegates` agent; `as: 'agentConfig.*'` wiring in
`src/conversations/eventAssistant.ts`), requires no schema migration
(`agentConfig` is `Mixed`), and keeps "what should happen inside breakouts" next
to the agent that coordinates them. The generic breakout service consumes this
config but does not depend on any particular agent type.

#### Discarded: breakout config on the Conversation or Adapter

Rejected for the behavioral parts: the conversation/adapter should not encode
which agent type to spawn or its prompt/history behavior — that is agent policy.
Platform plumbing (bot mode, room→bot mapping) does live on the adapter, but the
*intent* (spawn agent X with config Y per room) belongs with the agent.

### Decision D — Room definition: dynamic discovery + optional enrichment

Rooms are discovered at runtime from Recall webhooks (`room.id`, `room.name`),
because Zoom breakouts (whether pre-assigned or impromptu) only surface to us
when they open. The optional `agentConfig.breakout.rooms[]` provides
name/description **enrichment** matched against the Zoom room name. Description
is purely our own concept (Zoom has none), so it is a nice-to-have.

#### Discarded: fully pre-configured rooms matched to Zoom

Rejected as the primary path. Zoom room identity/ordering is not reliably known
ahead of time; forcing pre-declaration would break impromptu breakouts. Dynamic
discovery with optional enrichment covers both planned and impromptu cases.

### Decision E — Zoom orchestration via coordinator + per-room bots

When breakout is enabled, the main adapter deploys its bot in
`join_main_room` mode (coordinator). On `bot.breakout_room_opened`, the handler
creates a per-room zoom adapter and dispatches a `join_specific_room` bot, then
calls the core breakout service. Each room bot's transcript/chat is routed to
that room's channels via the room adapter's own `audioChannels`/`chatChannels`,
so existing inbound/outbound routing is reused unchanged.

#### Discarded: a single bot hopping between rooms

Rejected — impossible by Recall's model (a bot records one room at a time) and
unable to capture N rooms concurrently.

---

## 4. Data flow

```mermaid
flowchart TB
  subgraph zoomLayer [Zoom/Recall layer - adapters + handlers]
    Coord["Coordinator bot (join_main_room)"]
    RoomBot["Per-room bot (join_specific_room)"]
    Recall["src/handlers/recall.ts"]
    ZAdapter["src/adapters/zoom.ts"]
  end
  subgraph core [Core - generic breakout]
    BSvc["services/breakout.service.ts"]
    Chan["Channel.breakout marker"]
    Hist["getConversationHistory + includeBreakouts"]
    Tr["agents/helpers/transcript.ts (channel-parameterized)"]
    Agent["Agent.respond()"]
  end
  Coord -->|"breakout_room_opened/closed"| Recall
  RoomBot -->|"transcript/chat for its room"| Recall
  Recall -->|"openBreakoutRoom / closeBreakoutRoom / reconvene"| BSvc
  ZAdapter -->|"deploy coordinator + room bots"| Coord
  BSvc --> Chan
  BSvc -->|"spawn scoped room agent"| Agent
  Chan --> Hist
  Chan --> Tr
  Agent --> Hist
```

Lifecycle:

1. Session starts; if `agentConfig.breakout.enabled`, the coordinator bot joins
   the main room in `join_main_room` mode.
2. Host opens breakouts -> `bot.breakout_room_opened` per room -> handler creates
   per-room adapter + bot and calls `breakoutService.openBreakoutRoom`, which
   creates the room's channels and spawns a scoped room agent.
3. During the round: each room agent sees parent + own channels only; the main
   agent excludes breakout channels.
4. Host closes breakouts -> `bot.breakout_room_closed` per room ->
   `closeBreakoutRoom`; when the round is empty, `closeBreakoutRound` +
   `reconvene` flips the main agent to `includeBreakouts: 'all'`.
5. Subsequent rounds repeat with a fresh `roundId`; all prior content remains in
   the reconvened context, labeled per room.

---

## 5. Implementation plan

Ordered so core (generic) lands first, then the Zoom layer, then tests/docs.

### Step 1 — Channel breakout marker (core)

Files: `src/models/channel.model.ts`, `src/types/index.types.ts`.

- Add optional `breakout` to `IChannel`:
  ```ts
  breakout?: {
    roomId: string      // normalized room id (from adapter)
    roundId: string     // groups a simultaneous round
    name?: string
    description?: string
    kind?: 'transcript' | 'chat'
    active?: boolean     // false once the room closes
  }
  ```
- Add the matching sub-schema to `channelSchema` (default `undefined`).
- Add a small helper to query breakout channels for a conversation and to group
  them by `roundId` (e.g. `getBreakoutChannels(conversation)` in
  `src/utils/` or in the breakout service).

### Step 2 — Breakout service (core)

File: new `src/services/breakout.service.ts`. Generic, no Zoom imports.

- `openBreakoutRoom(conversation, { roundId, roomId, name?, description?, sourceChannels?, breakoutConfig })`:
  - Resolve/start a round (`roundId`): if none active, begin one; otherwise join
    the active round.
  - Create per-room channels via `channelService.createChannel` with the
    `breakout` marker set (`kind: 'transcript'` and `kind: 'chat'`), e.g. names
    `breakout/{roundId}/{roomId}/transcript` and `.../chat`.
  - Spawn the scoped room agent via `agentService.createAgent(agentType,
    conversation, props)` where `agentType = breakoutConfig.agentType` and props
    set `triggers.perMessage.channels` + `conversationHistorySettings.channels`
    to `[parent channels] + [this room's channels]` (merging
    `breakoutConfig.historySettings` / `agentConfig`).
  - Return handles `{ channels, agent }`.
- `closeBreakoutRoom(conversation, { roomId })`: mark the room's channels
  `breakout.active = false`; deactivate its room agent (`active = false`) without
  deleting it (preserve authorship/pseudonyms for reconvened context).
- `closeBreakoutRound(conversation, roundId)`: close all rooms in the round.
- `reconvene(conversation, { roundId? })`: set the coordinator/main agent(s)
  `conversationHistorySettings.includeBreakouts = 'all'` (and any
  per-trigger overrides) so the combined session includes all breakout content.

### Step 3 — Context scoping (core)

Files: `src/types/index.types.ts`, `src/models/user.model/agent.model/index.ts`
(leave `src/agents/helpers/getConversationHistory.ts` pure).

- Add `includeBreakouts?: 'none' | 'all'` to `ConversationHistorySettings`
  (default treated as `none`).
- In `Agent.respond()`, where channel settings are resolved (around the existing
  channel/direct-channel resolution): if `includeBreakouts === 'all'`, expand the
  resolved `channels` allow-list with all breakout channel names from the
  populated `conversation.channels`. Room agents need no change (their allow-list
  is explicit from Step 2).

### Step 4 — Transcript de-hardcoding (core)

File: `src/agents/helpers/transcript.ts`.

- Parameterize the transcript channel name(s) (currently the literal
  `'transcript'`) in `getTranscriptMessages` (line ~111), `getTranscript`, and
  the in-memory filter in `searchTranscript` (line ~78), defaulting to
  `['transcript']` for the main room and accepting the room's transcript channel
  for a room agent.
- In `loadTranscriptIntoVectorStore`, add breakout metadata (`roomId`,
  `roundId`, `channel`) to chunks so vector search can be scoped to a room and
  re-aggregated on reconvene. Keep the per-conversation RAG collection; filter by
  metadata rather than creating per-room collections.
- Audit `clearTranscript` / `deleteTranscript` /
  `loadTopicTranscriptsIntoVectorStore` (lines ~306/351/387) so breakout
  transcript channels are included in cleanup.

### Step 5 — History formatting (core)

File: `src/agents/helpers/llmInputFormatters.ts`.

- When formatting history for the reconvened main agent, label messages that
  originate from a breakout channel with their room name (and description if
  present) so the combined context is clearly attributable per room.

### Step 6 — agentConfig.breakout block (core/agent policy)

Files: `src/agents/eventAssistant/eventAssistant.ts` (coordinator defaults),
`src/conversations/eventAssistant.ts` (wiring), optionally
`src/agents/helpers/verify.ts` docs.

- Add the optional `breakout` block to the coordinator agent type's default
  `agentConfig` (Decision C shape).
- Add conversation-type wiring (`$ref` / `as: 'agentConfig.breakout.*'`) so the
  feature can be enabled/configured at conversation creation.
- Read via `this.agentConfig?.breakout?.*` with safe defaults; no central schema
  change.

### Step 7 — Recall handler (Zoom-specific)

File: `src/handlers/recall.ts`.

- Add `bot.breakout_room_opened`, `bot.breakout_room_closed`,
  `bot.breakout_room_entered`, `bot.breakout_room_left` to `supportedEvents`.
- On `breakout_room_opened` (received by the coordinator bot): create a per-room
  zoom adapter, dispatch the room bot, and call
  `breakoutService.openBreakoutRoom` with the room id/name and the coordinator's
  `agentConfig.breakout` config.
- On `breakout_room_closed`: call `breakoutService.closeBreakoutRoom` and stop
  that bot; when the round empties, `closeBreakoutRound` + `reconvene`.
- Use `entered`/`left` for bot-placement confirmation / participant tracking.
- Reuse existing `botId`-based adapter resolution; per-room transcript/chat
  routes to the room adapter automatically.

### Step 8 — Zoom adapter (Zoom-specific)

File: `src/adapters/zoom.ts`.

- When `agentConfig.breakout.enabled`, deploy the coordinator bot with
  `breakout_room: { mode: 'join_main_room' }` and subscribe to the breakout
  webhooks; otherwise keep current behavior.
- Add room-bot deployment with `breakout_room: { mode: 'join_specific_room',
  room_id }`. The room adapter's `audioChannels`/`chatChannels` point at that
  room's channels so `receiveMessage` / `getChannels` / `sendMessage` work
  unchanged.
- Update `getUniqueKeys()` (line ~447) so breakout adapters sharing the same
  `meetingUrl` do not collide (include `botId` or `roomId`).

### Step 9 — Tests & docs

- Core: `tests/services/breakout.service.test.ts` (open/close/reconvene, round
  lifecycle); context isolation + reconvene aggregation tests alongside existing
  `getConversationHistory` tests.
- Adapter/handler: extend `tests/handlers/recall.handler.test.ts` and
  `tests/adapters/zoom.adapter.test.ts` for breakout webhooks, room-bot
  dispatch, and per-room routing.
- Docs: update `docs/pages/platforms/zoom.md` (the Zoom "Let participants choose
  room" requirement and new Recall webhook subscriptions) and reference this
  document.

---

## 6. Risks & open items

- **Transcript RAG scoping** is the most invasive core change; the channel-name
  parameterization plus chunk metadata must be applied consistently across
  search, load, and cleanup paths.
- **Recall webhook enablement**: workspaces created before 2025-10-13 may need
  the breakout webhooks enabled by Recall support; `join_main_room`
  opened/closed events require Zoom's "Let participants choose room".
- **Round identity**: `roundId` is defined by the breakout service
  (start-on-first-open, end-on-last-close); Recall provides only per-room ids.
- **Bot cost/limits**: N rooms = N bots; surface clear logging and teardown to
  avoid orphaned bots.

---

## 7. Out of scope / assumptions

- Description is optional enrichment only (Zoom has no native field).
- Reuses the per-conversation RAG collection with added room metadata rather than
  per-room collections.
- No change to the child-conversation model; everything stays in one
  conversation.
