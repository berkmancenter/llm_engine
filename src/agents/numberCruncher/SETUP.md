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
