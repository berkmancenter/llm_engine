# Number Cruncher: provisioning and setup

How to stand up the Number Cruncher (NC) bot as its own Slack app and wire it to an
llm_engine instance, both for local development and for production. NC checks one or more
LLM API budget endpoints on a configurable schedule and posts an alert to a Slack channel
whenever any budget exceeds its configured threshold.

NC is a proactive periodic agent anchored to a long-lived Conversation, provisioned from
the `numberCruncher` conversation type. It uses the per-bot Slack identity: its webhook is
routed at `/v1/webhooks/slack/:appKey` and its signing secret lives on its own Adapter row,
not the global env var. That per-bot isolation lets a dev NC and a prod NC coexist in the
same Slack workspace without colliding: different `appKey`s, different Adapter rows, and
different Conversations in different databases.

## How the pieces fit (read once)

- **The Slack app** holds the bot token, signing secret, scopes, and a single Event
  Subscriptions Request URL. That URL points at exactly one server, so one Slack app cannot
  serve both your laptop and production at the same time. Use a separate Slack app per
  environment (see "Moving to production").
- **The webhook host** is wherever the llm_engine server is reachable over HTTPS. The
  Slack Request URL is `https://<that host>/v1/webhooks/slack/<appKey>`.
- **The Adapter row + Conversation** are created in the target database by the provisioning
  call below. Local provisioning writes to your dev DB; production provisioning writes to
  the production DB. Nothing is migrated between them — re-provision per environment.
- **Secrets** (bot token, signing secret, budget API keys) are passed into the provisioning
  call and stored on the Adapter/Conversation rows in that environment's DB, not in `.env`.
  The global `SLACK_SIGNING_SECRET` env var is only a fallback for bots that do not set
  their own.
- **Budget checks** are purely outbound. NC never needs to receive Slack events. The
  Request URL only needs to exist so Slack can verify it; you do not need to subscribe to
  any message events.

---

## Part A: Create NC's Slack app

Do this once per environment (one app for dev, one for prod).

1. Create a new Slack app in your workspace. NC is a separate app so it shows up as its
   own bot user (name, avatar, permissions). Name them distinctly per environment, e.g.
   "Number Cruncher (dev)" and "Number Cruncher".
2. Request bot token scopes. NC only posts messages, so it needs only **`chat:write`**.
3. Install the app to the workspace and copy the **Bot User OAuth token** (`xoxb-...`).
   Make sure it is the Bot token, not the User token.
4. From Basic Information, copy the **Signing Secret**.
5. Note the **workspace (team) ID** (`T...`) and the **channel ID** of NC's alert channel
   (`C...` or `G...`).
6. Invite the bot to its alert channel: `/invite @YourNumberCruncherBot`. NC can only post
   to channels it is a member of.

Leave the Event Subscriptions Request URL for Part C.

### Where to find each Slack value

Every `slack*` property in the Part B provisioning call comes from one of two places: the
Slack app admin (api.slack.com/apps) or the Slack client itself. Slack hides the ID values
(channel, workspace, bot user) behind copy buttons rather than showing them inline, so:

| Property | Value | Where to find it |
|---|---|---|
| `slackBotToken` | Bot User OAuth token (`xoxb-…`) | api.slack.com/apps → your app → **OAuth & Permissions** → *Bot User OAuth Token*. Must be the **Bot** token, not the User token (`xoxp-`). |
| `slackSigningSecret` | App signing secret | api.slack.com/apps → your app → **Basic Information** → *App Credentials* → *Signing Secret* (click **Show**). |
| `slackChannel` | Channel ID (`C…` public, `G…` private) | In the Slack client, open the channel → click its name → **About** tab → *Channel ID* at the bottom (copy button). Or right-click the channel → **Copy link**: the ID is the last path segment (`…/archives/C0123ABC`). |
| `slackWorkspace` | Workspace / team ID (`T…`) | The Slack web client URL after you sign in: `app.slack.com/client/T0123ABC/…` — the `T…` segment. |
| `slackBotUserId` | Bot's user ID (`U…`) | Optional. Easiest: provision without it, then run `yarn check:number-cruncher-slack --auth-only`, which prints the bot user id. Also shown on **OAuth & Permissions** after install. |
| `slackAppKey` | Webhook path slug (you choose) | Not from Slack — you pick it (e.g. `nc-dev`). It becomes the last segment of the Request URL in Part C. |
| `botName` | Display name (you choose) | Not from Slack — optional, defaults to "Number Cruncher". |

---

## Part B: Provision NC in llm_engine (BEFORE setting the Request URL)

This step creates NC's Adapter row and Conversation. Run it against the target instance's
API.

Pick an `appKey`: a short unique slug that becomes the last path segment of NC's webhook
URL. Use distinct keys per environment, e.g. `nc-dev` locally and `nc` in production.

Provisioning must happen before Slack verifies the Request URL, because URL verification
hits `/v1/webhooks/slack/<appKey>` and the handler looks up the adapter by `appKey` to
validate the challenge. If you set the Request URL first, Slack reports "Your URL didn't
respond with the value of the challenge parameter."

`POST <API host>/v1/conversations/from-type` with an admin bearer token:

```json
{
  "type": "numberCruncher",
  "name": "Number Cruncher",
  "platforms": ["slack"],
  "properties": {
    "slackChannel": "<channel ID, C... or G...>",
    "slackWorkspace": "<workspace ID, T...>",
    "slackBotToken": "<xoxb-... bot token>",
    "slackBotUserId": "<bot user ID, U...>",
    "slackSigningSecret": "<app signing secret>",
    "slackAppKey": "nc-dev",
    "botName": "Number Cruncher",
    "checkInterval": "3600",
    "budgets": [
      {
        "label": "AWS Bedrock",
        "endpoint": "https://api.example.com/budget/bedrock",
        "apiKey": "<your-api-key>",
        "thresholdPercent": 80
      },
      {
        "label": "OpenAI",
        "endpoint": "https://api.example.com/budget/openai",
        "apiKey": "<your-api-key>",
        "thresholdPercent": 80
      }
    ]
  }
}
```

**`budgets`** is an array of budget configurations. Each entry requires:
- `label` — display name shown in the alert (e.g. `"AWS Bedrock"`)
- `endpoint` — URL that returns `{ "quota": { "limit": "250.0" }, "remaining_limit": "199.40" }`
- `apiKey` — sent as `Authorization: Bearer <apiKey>` on each request
- `thresholdPercent` — integer 0–100; NC alerts when `(limit - remaining) / limit * 100 >= thresholdPercent`

**`checkInterval`** is in seconds. Defaults to `86400` (24 hours). Set to `3600` for hourly
checks. The value is baked into `triggers.periodic.timerPeriod` on the agent at creation
time.

`slackBotUserId` and `slackSigningSecret` are optional in the type definition but recommended:
the bot user ID prevents NC from reacting to its own Slack messages, and the signing secret
gives NC its own per-bot identity for webhook validation.

---

## Part C: Point Slack at NC's webhook and verify

Now that NC's Adapter row exists:

1. Make the llm_engine server reachable over HTTPS.
2. In the Slack app's Event Subscriptions, set the Request URL to
   `https://<host>/v1/webhooks/slack/<appKey>`. Slack sends a challenge; the handler
   echoes it and the URL turns verified.
3. NC does not need to subscribe to any message events. The Request URL only needs to
   verify. Leave event subscriptions empty.

---

## Local development specifics

- Run the server with `yarn run dev` (defaults to `PORT=3000`).
- Expose it over HTTPS with an ngrok tunnel to port 3000. The tunnel URL is your webhook
  host: `https://<subdomain>.ngrok-free.app/v1/webhooks/slack/nc-dev`. ngrok URLs change
  on restart unless you have a reserved domain, so you may need to re-set the Request URL
  after restarting the tunnel.
- Provision against `http://localhost:3000` (Part B) with a dev admin token.
- To trigger a check immediately without waiting for the schedule, use
  `POST /v1/messages` (see "Smoke test" below).

## Production specifics

- The webhook host is the deployed llm_engine domain. No tunnel.
- `MONGODB_URL` points at the production database.
- Secrets (bot token, signing secret, budget API keys) go in the provisioning call, stored
  on the production Adapter/Conversation rows. Keep them out of source control.

---

## Moving from local to production

There is no data migration — re-run the same setup against the production instance:

1. **Create a second Slack app for production** (Part A). A Slack app has one Event
   Subscriptions Request URL, so the dev app and the prod app must be separate apps. They
   can live in the same workspace; the per-bot `appKey` keeps their webhooks distinct.
2. **Provision against the production API** (Part B) with a production admin token, the
   prod Slack app's bot token and signing secret, and a distinct `appKey` (e.g. `nc`).
3. **Set the prod app's Request URL** to `https://<deployed domain>/v1/webhooks/slack/nc`
   and verify (Part C).

### Updating an existing conversation

To change the bot token, signing secret, budget list, or check interval on an existing
provisioned NC, you do not need to re-provision. `PUT /v1/conversations` with only the
changed properties:

```json
{
  "id": "<NC conversation id>",
  "properties": {
    "checkInterval": "7200",
    "budgets": [
      {
        "label": "AWS Bedrock",
        "endpoint": "https://api.example.com/budget/bedrock",
        "apiKey": "<updated-key>",
        "thresholdPercent": 75
      }
    ]
  }
}
```

Only the keys you send change. The conversation must be inactive (NC's Conversation always
is, since it never starts as an event).

---

## Smoke test the outbound path

Confirm NC can post before relying on the schedule.

`POST <API host>/v1/messages` with an admin bearer token:

```json
{
  "conversation": "<NC conversation id from Part B>",
  "body": "Number Cruncher online.",
  "bodyType": "text",
  "channels": [{ "name": "numberCruncher", "passcode": null }]
}
```

The message should appear in NC's alert channel.

## Verify the budget check

Wait for the next scheduled check (based on `checkInterval`), or reprovision with a short
interval like `"checkInterval": "60"` to trigger a check within a minute. If any configured
budget is above its threshold, NC posts a budget alert card to the channel showing a
progress bar, percent used, and dollar amounts for each over-threshold budget.

To force an alert regardless of actual usage, temporarily lower `thresholdPercent` to `0`
in the `budgets` array and update via `PUT /v1/conversations`.

---

## Gotchas, in one place

- Provision (create the Adapter row) BEFORE setting the Slack Request URL, or challenge
  verification fails.
- One Slack app = one Request URL. Use a separate app per environment.
- `chat:write` is the only scope needed. NC never reads messages.
- `checkInterval` is in **seconds**, not hours. `3600` = 1 hour, `86400` = 24 hours.
- `POST /v1/messages` channels are `[{ "name", "passcode" }]` objects. Use `passcode: null`
  to bypass the channel passcode.
- Secrets (bot token, signing secret, budget API keys) go in the provisioning call, stored
  on the Adapter/Conversation rows — not in `.env`. The global `SLACK_SIGNING_SECRET` is
  only a fallback.
- NC must be invited to its alert channel.
- Budget endpoint responses must have the shape
  `{ "quota": { "limit": "250.0" }, "remaining_limit": "199.40" }`. Unexpected shapes are
  skipped with a warning log.
- Each budget's `apiKey` is sent as `Authorization: Bearer <apiKey>`. If an endpoint returns
  a non-2xx status, that budget is skipped and the others still run.

---

## Cost summaries per event

When any conversation stops — public or private — its LLM runs are fetched from
LangSmith and stored as a `ConversationCost` record split into `liveEvent` (spend
while the conversation was running) and `postEvent` (spend on after-the-fact work
like the Vibes Analyst recap and the conversation summary).

**Cost tracking does not depend on Number Cruncher being provisioned.** It is core
functionality for every conversation, gated only by `ENABLE_CONVERSATION_COST_TRACKING`
(defaults to `true`). On every stop, `doStopConversation` schedules a standalone
`conversationCost` job that computes and persists the record via the shared
`conversationCostTracking` service. Number Cruncher's role is strictly the Slack-facing
part: when an NC agent is active, it runs the same tracking flow itself (so it can also
post a cost summary card — combined total plus the phase breakdown — to its admin
channel), and the standalone job detects that active agent and steps aside to avoid a
duplicate settle-poll. With no NC provisioned, the standalone job still records the cost;
there is simply no card.

A `ConversationCost` record is written immediately when the event stops (status
`pending`), carrying whatever LangSmith has already ingested at that instant — a real
preliminary estimate rather than a zeroed placeholder, falling back to zeros only when
nothing has landed yet. It is then updated to `status: complete` once the settle-poll
resolves — so a crash or a very slow settle never leaves zero record that the event
happened.

Private topics: Number Cruncher holds an `allTopics` read grant (broader than every
other agent, which are `allPublicTopics`-only), so it still records `liveEvent` cost for
a private event — real money was spent regardless of the topic's privacy. `postEvent`
is much smaller for a private event, because the post-event *agents* (e.g. the Vibes
Analyst recap) are `allPublicTopics`-only and never run on a private topic. It is not
necessarily empty, though: the conversation summary is generated on stop regardless of
privacy (see `doStopConversation`) and is tagged `costPhase: 'postEvent'`, so a private
event's `postEvent` typically reflects just that one summary call. The posted Slack card
redacts the event's name to "Private event" for these; the persisted Mongo record keeps
the real name and is tagged `topicIsPrivate: true` so it can still be queried/reported on
internally.

Requirements:

- `LANGSMITH_TRACING_V2=true`, `LANGSMITH_API_KEY`, and `LANGSMITH_PROJECT` must be
  set — without tracing there is nothing to price, so tracking is skipped entirely
  (one log line, no settle-poll) and no card is posted.
- `ENABLE_CONVERSATION_COST_TRACKING` must be enabled (it is by default). Set it to
  `false` to turn off cost recording for all conversations.
- Only conversations that ran **after** conversationId trace tagging shipped have
  cost data; historical events will never produce a record or card.

Caveats:

- Figures use LangSmith's internal pricing table, not negotiated provider rates
  (Bedrock regional pricing and discounts differ), so the card always labels them
  estimates.
- The fetch polls until run counts settle (up to ~7 minutes after the stop), so the
  cost card arrives several minutes after the event ends, after the Vibes Analyst
  recap. Progress is logged at each poll attempt (debug) and on settle/exhaust (info).
- Failed or retried agent runs still consumed tokens and are counted.

### Confirming the integration works

You do not need to wait for a real event to stop to check that NC can post cost cards.

**Testing cost cards without budget endpoints.** The cost-card path
(`onConversationEvent`) is independent of the budget-alert path (`respond`), so you can
provision NC for cost-card testing without configuring any real budget endpoints, API
keys, or thresholds. Pass an **empty** `budgets` array in the provisioning call (Part B):

```json
"properties": {
  "slackChannel": "<C... or G...>",
  "slackWorkspace": "<T...>",
  "slackBotToken": "<xoxb-...>",
  "slackAppKey": "nc-dev",
  "budgets": []
}
```

`budgets` is `required`, so the key must be present, but `[]` is accepted — the scheduled
budget check simply returns early with nothing to check (see `agent.ts`, `respond()`),
while the Slack adapter and the `numberCruncher` agent are still created, which is all the
cost card needs. This is the recommended way to smoke-test the Slack cost card locally.

Two levels of check:

**1. Slack path only (fast, no LangSmith).** Run the bundled probe. It reads NC's stored
Slack credentials from the database, checks the bot token, renders a sample cost card
with the *real* card renderer, and posts it to NC's channel — so a valid token that can
post a well-formed card confirms the whole outbound path:

```bash
# Posts a clearly-labeled sample card to NC's channel (reads MONGODB_URL from .env)
yarn check:number-cruncher-slack

# Just validate the token and identity; post nothing
yarn check:number-cruncher-slack --auth-only

# Preview the private-topic (name-redacted) variant of the card
yarn check:number-cruncher-slack --private

# Resolve creds and render, but make no Slack calls at all
yarn check:number-cruncher-slack --dry-run

# Probe a specific conversation's Slack adapter instead of auto-finding NC
yarn check:number-cruncher-slack --conversation=<conversationId>

# Against production (defaults to development otherwise)
NODE_ENV=production yarn check:number-cruncher-slack
```

A `✔ Sample cost card posted…` line (and a card visible in the channel) means the
integration is wired up. Failures print the specific fix — e.g. invite the bot to the
channel (`not_in_channel`), correct the channel id (`channel_not_found`), add the
`chat:write` scope (`missing_scope`), or re-provision the token (`invalid_auth`).

**2. Full cost-calculation path (end to end).** Requires LangSmith configured (see
Requirements above). Stop a real (non-experimental) conversation that ran at least a few
LLM calls, then:

- Watch the logs for `conversationCost:` lines — the pending record, the settle-poll
  progress, and the final settled total.
- Confirm a `ConversationCost` record exists in Mongo for that `conversationId`, moving
  from `status: pending` to `status: complete`.
- If NC is provisioned, the cost card appears in its channel a few minutes after the
  event ends (after the settle-poll). If NC is not provisioned, the record is still
  written (by the standalone `conversationCost` job) — there is simply no card.
