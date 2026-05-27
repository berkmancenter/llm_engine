## Optional: Set up Slack integration

LLM Engine integrates with Slack to allow agents to participate in Channel discussions or direct messages. Follow these steps to create a Slack app that can be invited to discussions in a workspace.

### One Time Setup - Create the app in Slack

These instructions roughly follow the steps outlined in Slack's Quickstart Guide [Creating an app from app settings](https://docs.slack.dev/app-management/quickstart-app-settings).

Get a free Slack Developer sandbox and then complete Step 1 in the Guide, `Create an App`. We named our app LLM Engine, but you can name yours anything.

#### Request Scopes

Follow Step 2 `Requesting Scopes` to request the following Bot Token Scopes:

- chat:write
- chat:write.public (if using in public channels)
- channels:read

#### Enable Direct Messaging from Messages Tab

If you want to allow users to direct message the app, check the `Allow users to send Slash commands and messages from the messages tab` box under the `App Home` tab.

#### Install and Authorize the App in your Workspace

Follow Step 3 `Installing and Authorizing the App`

NOTE: you must invite the app to a channel in order for agents to participate

`/invite @LLM Engine` (or whatever you named the app when you created it)`

#### Configure the app for event listening

Follow Step 4 `Configuring the app for event listening.` Set the request URL to the following address of your running LLM Engine server:
`https://[base URL]/v1/webhooks/slack`

Subscribe to the following bot events

- message.channels
- message.groups
- message.im (if using direct messages)

#### Add environment variables

Set the following environment variable in the LLM Engine `.env` file:

```
SLACK_SIGNING_SECRET - found under Basic Information in your Slack app configuration
```

### Using Slack with LLM Engine

1. Ensure ngrok tunnel is running or LLM Engine is otherwise remotely accessible.
2. Determine your workspace ID. It is the last part of the URL when you select the workspace, starting with T.
3. Determine the Slack Channel ID. It is the last part of the URL when you select the channel in Slack.
4. Copy your Bot User OAuth Token under OAuth & Permissions in your Slack app configuration for your workspace. Each workspace has a unique bot token. NOTE: make sure you copy the _Bot_ token and not the _User_ token.
5. Create a `Conversation` with the desired channels and provide the Slack Channel ID, Workspace ID, Bot Token, and Bot Name/App Display Name in the Slack `adapter config`

Example conversation body:

```
{
    "name": "Should plastic water bottles be banned?",
    "topicId": "{{defaultTopic}}",
    "channels": [ { "name": "moderator"}, { "name": "participant"}],
    "adapters": [ {"type": "slack", "config" : {"channel": "C08US6FL6DV", "workspace: "T123494", "botToken":"[token]", "botName": "Berkie"},
        "chatChannels": [ { "name": "playfulSlack", "direction": "both"}]}]
}
```

**NOTE: A unique Slack workspace and channel combination can only be associated with one active Conversation**

6. Post a message to the Slack Channel. Any agents configured on the `Conversation` should receive and send messages on their typical channels.

### Event Setup bot (Slack → Nextspace handoff)

The `eventSetup` agent lets an organizer kick off a new Nextspace event from Slack. When the organizer mentions the bot or posts a setup-intent message (e.g. "create an event") in a designated Slack channel, the bot replies with a link to the Nextspace event-creation form. The link carries a signed handoff token (JWT) so the form knows which Slack user, team, channel, and thread the request came from. The form lives in Nextspace; this server only mints and verifies the token and runs the planner endpoint the form calls.

A note on channel naming, because there are two different things both called "channel":

- The **Slack channel** is the actual channel in your Slack workspace where organizers post setup requests. You can name your channel anything.
- The **Nextspace channel role** is an internal label this codebase uses to describe what a channel is for. The `eventSetup` agent listens on a role literally named `setup`. Other agents listen on roles like `transcript` or `chat`. Operators do not need to rename these roles. They are part of the agent's contract, the same way every other agent in the codebase declares the role it serves.

The Slack adapter bridges the two. In the Conversation you create below, `adapters[0].config.channel` says which Slack channel ID you want, and `adapters[0].chatChannels` maps that Slack channel into the `setup` role the agent listens on. So renaming your Slack channel never requires a code change, only an update to the Conversation config.

#### Environment variables

These are all that's needed for the event setup bot. No separate URL templates, calendar deeplink, or display timezone settings are needed. Those concerns moved to the Nextspace frontend.

| Variable                           | Required        | Purpose                                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_HOST`                         | yes             | Public URL of the Nextspace frontend. The bot builds the handoff link as `${APP_HOST}/events/new#token=...`. The token is placed in the URL fragment (after `#`) so browsers never send it to the Nextspace server, keeping it out of server access logs and Referer headers. |
| `JWT_SECRET`                       | yes             | Signs and verifies the handoff token. Must match between the Slack bot's process and any process that verifies the token (this same llm_engine instance).                                                                                                                     |
| `HANDOFF_TOKEN_EXPIRATION_MINUTES` | no (default 60) | How long the link stays valid after the bot posts it. Short window is intentional.                                                                                                                                                                                            |
| `SLACK_SIGNING_SECRET`             | yes             | Verifies inbound Slack webhooks (general Slack requirement, not event-setup specific).                                                                                                                                                                                        |
| `SYSTEM_USERS`                     | recommended     | Include `event-setup-bot:serviceAccount` so the bot has an account to act under. See [Installing](../installing/index.md).                                                                                                                                                    |

#### Slack-side setup

**Prerequisite:** complete the _One Time Setup - Create the app in Slack_ section at the top of this document first. That section walks through creating the LLM Engine Slack app, requesting bot scopes, installing the app into your workspace, configuring event subscriptions, and setting `SLACK_SIGNING_SECRET`. The steps below assume the app already exists in your workspace and is reachable from your LLM Engine server.

The event setup bot has no additional Slack permissions beyond `chat:write` and the channel scopes already listed in the prerequisite section.

To trigger the bot in a workspace:

1. **Pick or create a Slack channel.** Name it whatever fits your team. This is the channel organizers will post in when they want to create an event.
2. **Invite the LLM Engine app to that channel** so it can read messages and post replies. In Slack: open the channel, click the channel name to open settings, go to the _Integrations_ tab, click _Add apps_, and select your LLM Engine app.
3. **Look up the Slack identifiers you'll need for the Conversation config:**
   - **Slack channel ID.** Open the channel in Slack, click the channel name, scroll to the bottom of the _About_ panel. The ID looks like `C` followed by alphanumeric characters.
   - **Slack workspace (team) ID.** Open the workspace in Slack on the web. The URL contains the workspace ID, which looks like `T` followed by alphanumeric characters.
   - **Bot User OAuth Token.** In your Slack app configuration at api.slack.com, go to _OAuth & Permissions_ and copy the _Bot_ token (not the User token). It starts with `xoxb-`.
4. **Create a Conversation** by POSTing to the admin API with the body below. Replace the four `<PLACEHOLDER>` values with the identifiers from step 3, your topic ID, and the name you want the bot to display in Slack.

   ```json
   {
     "name": "Event Setup",
     "topicId": "<NEXTSPACE_TOPIC_ID>",
     "channels": [{ "name": "setup" }],
     "agentTypes": ["eventSetup"],
     "adapters": [
       {
         "type": "slack",
         "config": {
           "channel": "<SLACK_CHANNEL_ID>",
           "workspace": "<SLACK_WORKSPACE_ID>",
           "botToken": "<SLACK_BOT_TOKEN>",
           "botName": "<BOT_DISPLAY_NAME>"
         },
         "chatChannels": [{ "name": "setup", "direction": "both" }]
       }
     ]
   }
   ```

   `channels[0].name` and `chatChannels[0].name` both stay as `"setup"`. That value is the Nextspace channel role the agent listens on, not a Slack channel name. The Slack-side name is whatever you picked in step 1, and you reference it by ID in `adapters[0].config.channel`.

5. **Post a setup request** in the Slack channel from step 1. Either mention the bot (e.g. `@<BOT_DISPLAY_NAME> create an event`) or use a setup-intent phrase like `create an event next Thursday`. The bot replies with the handoff link.

##### One Slack app per LLM Engine server

Before configuring multiple agents, know this constraint up front: a single LLM Engine server is bound to exactly one Slack app. The server verifies every inbound Slack webhook against the single `SLACK_SIGNING_SECRET` env var (see `src/handlers/slack.ts`), so webhooks from any other Slack app would fail signature verification and never reach an agent. There is no per-agent or per-Conversation signing secret.

That single Slack app can host many Conversations across many Slack channels and workspaces. What it cannot do is appear as more than one bot identity in Slack. Every outbound post from this server uses the installed app's bot user, with the display name and avatar configured at install time on api.slack.com. The adapter does not override `username` or `icon_url` per message (see `src/adapters/slack/index.ts`).

If you need agents to appear as visually distinct Slack users (e.g. Berkie posting as "Berkie" and Mason posting as "Mason"), you need a separate Slack app and a separate LLM Engine instance, each with its own signing secret and installed identity.

##### Sharing a Slack channel between multiple agents

A single Conversation can host more than one agent on the same channel binding. To put the event setup bot and another Nextspace agent (e.g. a moderator persona) into the same Slack channel, add both agent type names to the `agentTypes` array on the Conversation. They both attach to the `setup`-role channel binding declared in `chatChannels`.

Each agent evaluates incoming messages independently against its own triggers, so the two do not interfere with each other. If only one agent's triggers match a given message (e.g. only the event-setup intent pattern fires on `create an event next Thursday`), only that agent responds. If both match, each gets a chance to respond.

Because of the one-app-per-server constraint above, both agents appear in Slack under the same bot identity. The `agentConfig.botName` value on each agent definition is used for in-prompt addressing and trace metadata. It does not change what Slack displays.

##### How users address individual agents in a shared channel

Since every agent in the channel posts under the same Slack bot identity, the user cannot pick one out with a real Slack `@`-mention. Each agent resolves itself by inspecting the message body inside its own `evaluate()` function. The rules each agent applies fall into the categories below:

1. **Typed name in the message text.** The user types the agent's name as plain text: `Berkie, set up an event` or `@Mason can you summarize`. Each agent's `evaluate()` looks for its own `agentConfig.botName` in the body, independently of the others. Two matching styles exist in the codebase:
   - **Fuzzy** match via `matchBotMention()` in [intentChecks.ts](https://github.com/berkmancenter/llm_engine/blob/main/src/agents/helpers/intentChecks.ts). It uses fuzzball with a 70% ratio threshold, so small typos like `Berki` or `Berkey` still resolve. Used by chatbot and eventHistorian.
   - **Substring** match. The simplest form, used by `eventSetup`: `body.toLowerCase().includes('@' + botName.toLowerCase())` (see [eventSetup.ts](https://github.com/berkmancenter/llm_engine/blob/main/src/agents/eventSetup/eventSetup.ts)).
2. **Real Slack `@app` mention.** Slack's built-in mention (with the blue highlight) refers to the one bot user the app owns. The adapter rewrites that mention into the in-text token `@<botName>`, where `<botName>` is whatever is configured in `adapters[0].config.botName` (not the per-agent `agentConfig.botName`). So a Slack-level mention resolves to exactly one name. If that name matches an agent's `agentConfig.botName`, that agent fires; otherwise the message falls through to intent matching.
3. **Intent keywords.** If the user names no agent at all, each agent falls back to whatever intent pattern its `evaluate()` declares. For event setup, this is the regex set in `SETUP_INTENT_PATTERNS` (matches `setup`, `create an event`, etc.). For other agents it might be different keywords or an LLM intent check.

Worked examples for a Berkie + Mason channel:

| User types                        | Berkie matches                                                             | Mason matches    | Who responds    |
| --------------------------------- | -------------------------------------------------------------------------- | ---------------- | --------------- |
| `Berkie, set up an event`         | yes (typed name)                                                           | no               | Berkie          |
| `Mason, summarize the discussion` | no                                                                         | yes (typed name) | Mason           |
| `create an event next Thursday`   | yes (intent keyword)                                                       | no               | Berkie          |
| `@<adapter botName> hello`        | depends on whether the adapter botName matches their `agentConfig.botName` | same             | whoever matches |

If you put two agents on one channel, their `evaluate()` functions have to be written so they don't both fire on the same message. The reliable way to keep them apart is to require a name match in the body before responding, and to make sure their intent keywords don't overlap. When both agents fire on the same input, both respond, which gets confusing fast for the user.

#### Deploying to production

When merging this change to production, do these in order:

1. **Set `APP_HOST`** to the production Nextspace URL (e.g. `https://nextspace.example.org`). Without this the bot will post `localhost` links.
2. **Confirm `JWT_SECRET` is set** in the production environment and is not the placeholder from `.env.example`. The handoff token is signed with this secret; a weak or default secret means anyone can forge a handoff.
3. **(Optional) Set `HANDOFF_TOKEN_EXPIRATION_MINUTES`** if the default 60 minutes doesn't fit your workflow.
4. **Restart the llm_engine service** so the new config is loaded.
5. **Smoke test** by posting a setup request in the Slack channel the production Conversation is wired to, and confirming the bot replies with a link pointing at the production `APP_HOST`. Clicking the link should land on the Nextspace event-creation form. That part requires the matching Nextspace deploy with the frontend handler; track that separately.
6. **Verify token rejection paths** by hand-crafting a request to `POST /v1/event-setup/plan` without a token and with a tampered token. Both should return 401.

#### Local development

1. Copy `.env.example` to `.env` and set `APP_HOST=http://localhost:3000`, `JWT_SECRET=<anything>`, `SLACK_SIGNING_SECRET=<your dev app secret>`.
2. Run `yarn dev` (or your usual local script).
3. Expose the local server with ngrok or similar, point your Slack dev app's Event Subscriptions URL at it.
4. Create a dev Conversation following the steps above, pointing at a Slack channel in your dev workspace.
5. Post a setup request in that Slack channel. The bot will reply with a `localhost:3000` link.
6. Hit the planner endpoint directly with curl to iterate on the LLM prompt without the frontend. The token is the part of the bot's URL after `#token=`:

```bash
curl -X POST http://localhost:3000/v1/event-setup/plan \
  -H "X-Handoff-Token: <token from the # fragment of the bot's URL>" \
  -H "Content-Type: application/json" \
  -d '{"description":"AI ethics roundtable next Thursday at 3pm ET, online via Zoom"}'
```

### Direct messages

If you wish to support DMs between users and agents, you must configure a separate Conversation for all DMs. **You can only have one such Conversation active at a time.** Private communication between a user and the Slack app happens on a dedicated channel (different for each user). Therefore, you must use the keyword 'direct' for channel name, to signal that the conversation should process all direct messages.

Example conversation body:

```
{
    "name": "A chat",
    "topicId": "{{defaultTopic}}",
    "enableDMs": ['agents'],
    "agentTypes": [agents],
    "adapters": [ {"type": "slack", "config" : {"channel": "direct", "workspace: "T123494",  "botToken":"[token]", "botName": "Berkie"},
        "dmChannels": [{ "direct": true, "agent": "playfulPerMessage", "direction": "both"}]}]
}
```
