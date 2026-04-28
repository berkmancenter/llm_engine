## Adding a feature to the Quick Guide

Features are the capabilities listed in the participant-facing Quick Guide. Each maps to a tab in the Nextspace UI ("Berkie", "Group Chat", "Resources") and shows up in one of three tiers: slash commands, user-controlled settings, or always-on features.

### Define the feature

Add your feature to the `features` array in the relevant conversation type file, e.g. `src/conversations/eventAssistant.ts`. Each feature is a `FeatureConfig` object:

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Unique camelCase identifier. |
| `label` | Yes | Display name shown in organizer-facing UIs. |
| `description` | Yes | What the feature does. |
| `tab` | Yes | Which guide section to put it in: `"assistant"`, `"group-chat"`, `"transcript"`, or `"resources"`. |
| `audience` | Yes | Who sees it in the guide: `"participant"`, `"moderator"`, or `"both"`. |
| `default` | Yes | Whether the feature is on by default. Also used as a fallback for conversations that predate this feature. |
| `userControlled` | Yes | `true` if the participant can toggle or activate it; `false` if it runs automatically. |
| `agents` | Yes | Backend agents to start when the feature is enabled. Use `[]` for user-triggered features that don't need an agent. |
| `slashCommand` | No | The command participants type, without the `/`. Omit for passive features. |
| `participantDescription` | No | What participants see in the guide. Falls back to `description` if you leave this out. |
| `properties` | No | Sub-properties shown in the event creation form. |

Example:

```typescript
{
  name: 'mindmap',
  label: 'Mind Map',
  description: 'Creates a visual mind map of the key topics discussed in the event.',
  participantDescription: 'Generate a visual mind map of the key topics discussed so far.',
  tab: 'assistant',
  audience: 'participant',
  userControlled: true,
  slashCommand: 'mindmap',
  default: true,
  agents: [],
  properties: []
}
```

### How it appears in the guide

The `tab` field controls which section the feature lands in. Within a section, features are grouped into tiers based on `slashCommand` and `userControlled`:

- Commands: features with a `slashCommand`, shown as `/command` in the guide.
- Your settings: features with `userControlled: true` and no slash command.
- Always active: features with `userControlled: false` and no slash command.

### Feature state on existing conversations

When a conversation is created, every feature in the type definition is stored with an explicit `enabled: true` or `enabled: false`. If a conversation was created before a feature existed, it won't have a record for it, so the guide falls back to `feature.default`. That means a new feature with `default: true` will appear in the Quick Guide for pre-existing events without any database migration.
