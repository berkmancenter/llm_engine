# Vibes Analyst: provisioning and setup

How to stand up the Vibes Analyst (VA) bot as its own Slack app and wire it to an
llm_engine instance, both for local development and for production. VA posts an
engagement summary to a private admin channel whenever a public event ends.

VA is a normal agent anchored to a long-lived admin Conversation, provisioned from the
`vibesAnalyst` conversation type. It uses the per-bot Slack identity: its webhook is
routed at `/v1/webhooks/slack/:appKey` and its signing secret lives on its own Adapter
row, not the global env var. That per-bot isolation is what lets a dev VA and a prod VA
coexist (even in the same Slack workspace) without colliding: they have different
`appKey`s, different Adapter rows, and different Conversations in different databases.

## How the pieces fit (read once)

- **The Slack app** holds the bot token, signing secret, scopes, and a single Event
  Subscriptions Request URL. That URL points at exactly one server, so one Slack app
  cannot serve both your laptop and production at the same time. Use a separate Slack
  app per environment (see "Moving to production").
- **The webhook host** is just wherever the llm_engine server is reachable over HTTPS.
  There is no env var for it. it is your ngrok tunnel locally, your deployed domain in
  production. The Slack Request URL is `https://<that host>/v1/webhooks/slack/<appKey>`.
- **The Adapter row + Conversation** are created in the target database by the
  provisioning call below. Local provisioning writes to your dev DB; production
  provisioning writes to the production DB. Nothing is migrated between them. you
  re-provision per environment.
- **Secrets** (bot token, signing secret) are passed into the provisioning call and
  stored on the Adapter row in that environment's DB, not in `.env`. The global
  `SLACK_SIGNING_SECRET` env var is only a fallback for bots that do not set their own.

The provisioning and message API calls are identical across environments. only the API
host, the admin bearer token, the `topicId`, and the `appKey` change.

---

## Part A: Create VA's Slack app

Do this once per environment (one app for dev, one for prod).

1. Create a new Slack app in your workspace. VA is a separate app so it shows up as its
   own bot user (name, avatar, permissions), not as any existing bot. Name them
   distinctly per environment, e.g. "Vibes Analyst (dev)" and "Vibes Analyst". Under
   Basic Information, set the app icon to the lens mark in
   [`assets/lens-icon.svg`](assets/lens-icon.svg) (export it to PNG first; Slack icons
   want a square raster). The icon is the bot's identity in Slack and is configured on
   the app, not in any message payload.
2. Request bot token scopes. VA only needs **`chat:write`**. It posts to channels it has
   been invited to, so it does NOT need `chat:write.public`. Add `channels:read` only if
   you later want it to enumerate channels (not required for posting).
3. Install the app to the workspace and copy the **Bot User OAuth token** (`xoxb-...`).
   Make sure it is the Bot token, not the User token.
4. From Basic Information, copy the **Signing Secret**.
5. Note the **workspace (team) ID** (`T...`, last part of the workspace URL) and the
   **channel ID** of VA's admin channel (`C...`/`G...`, last part of the channel URL).
6. Invite the bot to its admin channel: `/invite @YourVibesBot`. VA can only post to
   channels it is a member of.

Leave the Event Subscriptions Request URL for Part C. ordering matters.

---

## Part B: Provision VA in llm_engine (BEFORE setting the Request URL)

This is the step that creates VA's Adapter row and Conversation. Run it against the
target instance's API.

Pick an `appKey`: a short unique slug that becomes the last path segment of VA's webhook
URL and is how the handler finds VA's Adapter row. Use distinct keys per environment,
e.g. `va-dev` locally and `va` in production.

Provisioning must happen before Slack verifies the Request URL, because URL verification
hits `/v1/webhooks/slack/<appKey>` and the handler looks up the adapter by `appKey` to
validate the challenge. If you set the Request URL first, Slack reports "Your URL didn't
respond with the value of the challenge parameter."

`POST <API host>/v1/conversations/from-type` with an admin bearer token for that
instance:

```json
{
  "type": "vibesAnalyst",
  "name": "Vibes Analyst",
  "platforms": ["slack"],
  "topicId": "<an admin/internal topic id in THIS instance's DB>",
  "properties": {
    "slackChannel": "<channel ID, C... or G...>",
    "slackWorkspace": "<workspace ID, T...>",
    "slackBotToken": "<xoxb-... bot token>",
    "slackBotUserId": "<bot user ID, U...>",
    "slackSigningSecret": "<app signing secret>",
    "slackAppKey": "va-dev",
    "botName": "Vibes Analyst"
  }
}
```

`slackBotUserId` and `slackSigningSecret` are optional in the type, but set them: the
bot user ID normalizes incoming mentions (used by Q&A later), and the signing secret is
what makes the per-bot identity real (the handler validates VA's webhooks against this,
not the global env var).

---

## Part C: Point Slack at VA's webhook and verify

Now that VA's Adapter row exists in the target instance:

1. Make the llm_engine server reachable over HTTPS (see the per-environment notes below).
2. In the Slack app's Event Subscriptions, set the Request URL to
   `https://<host>/v1/webhooks/slack/<appKey>`. Slack sends a challenge; the handler
   echoes it and the URL turns verified.
3. Event subscriptions (`message.channels`, `message.im`, etc.) are only needed once VA
   answers questions in Slack (a later phase). For auto-posting alone you do not need to
   subscribe to message events, but the Request URL must still verify.

---

## Local development specifics

- Run the server with `yarn run dev` (defaults to `PORT=3000`). Point `MONGODB_URL` at
  your dev database.
- Expose it over HTTPS with an ngrok tunnel to port 3000. The tunnel URL is your webhook
  host: `https://<subdomain>.ngrok-free.app/v1/webhooks/slack/va-dev`. ngrok URLs change
  on restart unless you have a reserved domain, so you may need to re-set the Request URL
  after restarting the tunnel.
- Provision against `http://localhost:3000` (Part B) with a dev admin token and a dev
  `topicId`.
- To exercise the curated card end to end, seed a public event with realistic engagement
  using `tests/manual/seedVibesAnalystTestEvent.ts`. Run it against your dev DB with
  `ADMIN_EMAIL=you@example.com node --loader ts-node/esm tests/manual/seedVibesAnalystTestEvent.ts`,
  then `POST /v1/conversations/<id>/stop`. Env vars at the top of the script tune the story
  (registered count, speaker count, past baseline, tracked-session numbers and state); see
  its header comment.

## Production specifics

- The webhook host is the deployed llm_engine domain (TLS-terminated, publicly
  reachable). No tunnel.
- `MONGODB_URL` points at the production database. The Adapter row and Conversation from
  Part B live there, separate from anything you provisioned locally.
- Provide secrets (bot token, signing secret) through the provisioning call as usual.
  they are stored on the production Adapter row. Keep them out of source control and out
  of shared logs.
- Use a `topicId` that exists in the production DB and an admin token for the production
  instance.

---

## Moving from local to production

There is no data migration. you re-run the same setup against the production instance.
Concretely:

1. **Create a second Slack app for production** (Part A). A Slack app has only one Event
   Subscriptions Request URL, so the dev app (pointing at your ngrok tunnel) and the prod
   app (pointing at the deployed domain) must be separate apps. They can live in the same
   workspace; the per-bot `appKey` keeps their webhooks distinct.
2. **Provision against the production API** (Part B) with a production admin token, a
   production `topicId`, the prod Slack app's bot token and signing secret, and a
   distinct `appKey` (e.g. `va`). This creates fresh Adapter and Conversation rows in the
   production DB.
3. **Set the prod app's Request URL** to
   `https://<deployed domain>/v1/webhooks/slack/va` and verify (Part C).
4. **Smoke test and verify** against production (Parts below).

What carries over from local to prod is the code (this agent, the conversation type, the
Block Kit renderer), which deploys with the rest of llm_engine. What does NOT carry over
is any provisioned state: every environment gets its own Slack app, Adapter row,
Conversation, channel, and secrets.

---

## Smoke test the outbound path

Confirm VA can post before relying on the event trigger.

`POST <API host>/v1/messages` with an admin bearer token. Channels must be objects, not
strings, and the channel carries an auto-generated passcode. pass it, or set `passcode`
to null:

```json
{
  "conversation": "<VA conversation id from Part B>",
  "body": "VA online.",
  "bodyType": "text",
  "channels": [{ "name": "vibesAnalyst", "passcode": null }]
}
```

The message should appear in VA's admin channel.

## Verify the real behavior

End a public (non-private) event in that environment. The dispatcher matches VA's
`allPublicTopics` read grant, fires the `conversationEvent` job, and VA posts its metrics
card to the admin channel within a minute.

## Gotchas, in one place

- Provision (create the Adapter row) BEFORE setting the Slack Request URL, or challenge
  verification fails.
- One Slack app = one Request URL. use a separate app per environment.
- `chat:write` is the only scope needed for posting. not `chat:write.public`.
- `POST /v1/messages` channels are `[{ "name", "passcode" }]` objects. Channels have an
  auto passcode; pass it or use `passcode: null`.
- Secrets go in the provisioning call (stored on the Adapter row), not `.env`. The global
  `SLACK_SIGNING_SECRET` is only a fallback.
- VA must be invited to its admin channel.
- VA reacts only to non-private topics (its `allPublicTopics` grant). private/dev events
  are ignored by design.
