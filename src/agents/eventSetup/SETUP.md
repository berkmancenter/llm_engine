# Event Setup Agent — Setup Guide

The event setup agent runs in a dedicated organizer Slack channel. Setting it up means creating a persistent "organizer conversation" that wires the agent to that channel. You do this once per environment — locally to test, then again when you deploy to production.

---

## Part 1: Slack App (one-time, shared across environments)

Create the Slack app once. Both local and production point at the same app — you just add each environment's webhook URL separately.

### Create the app
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g. "Nextspace Events") and select your workspace

### Configure OAuth scopes
**OAuth & Permissions** → **Bot Token Scopes** → add:
- `chat:write` — post messages to the channel
- `channels:history` — read messages in public channels
- `groups:history` — read messages in private channels

Click **Install to Workspace** and approve. Copy the **Bot User OAuth Token** (`xoxb-...`) — you'll use this in both environments.

### Get the Bot User ID
```bash
curl -H "Authorization: Bearer xoxb-..." https://slack.com/api/auth.test
```
Copy the `user_id` field (`U...`).

### Collect credentials
From **Basic Information** → **App Credentials**, copy the **Signing Secret** — you'll add this as `SLACK_SIGNING_SECRET` in both environments.

---

## Part 2: Local Development

### 2a. Expose your local server

Slack needs a public URL to deliver events. Use ngrok:

```bash
brew install ngrok   # if not already installed
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL. Note: the free tier assigns a new URL each time ngrok restarts — you'll need to update the Slack webhook URL each session.

### 2b. Add the signing secret to your local .env

```
SLACK_SIGNING_SECRET=<signing-secret from Part 1>
```

Restart the server after adding this.

### 2b-bis. Grant the bot access to private topics (optional)

The bot system user is created automatically on first startup — no action needed there.

If the event setup channel needs to work with private topics, add their IDs to `EVENT_SETUP_DEFAULT_TOPICS` in `.env` (comma-separated). The bot follows them on each startup:
```
EVENT_SETUP_DEFAULT_TOPICS=<topic-id>
```

To follow a topic without touching `.env`, call the follow endpoint with a bot-scoped token:
```bash
curl -X POST http://localhost:3000/v1/topics/follow \
  -H "Authorization: Bearer <bot-token>" \
  -H "Content-Type: application/json" \
  -d '{"topicId": "<topic-id>", "status": true}'
```

### 2c. Register the local webhook URL with Slack

In your Slack app → **Event Subscriptions** → toggle on → set Request URL:
```
https://xxxx.ngrok-free.app/v1/webhooks/slack
```

Under **Subscribe to bot events** add `message.channels` and `message.groups`. Save — Slack will verify the URL immediately.

### 2d. Create a test Slack channel

1. Create a private channel (e.g. `#event-setup-dev`)
2. Invite the bot: `/invite @<your-bot-name>`
3. Right-click the channel → **View channel details** → scroll to the bottom for the Channel ID (`C...`)
4. Your Workspace ID (`T...`) is visible in the Slack URL in a browser, or under **Settings & administration → Workspace settings**

### 2e. Get a bearer token

```bash
curl -X POST http://localhost:3000/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "<your-admin-email>", "password": "<your-password>"}'
```

Copy `tokens.access.token`.

### 2f. Create a topic

```bash
curl -X POST http://localhost:3000/v1/topics \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Event Setup", "description": "Parent topic for the organizer event setup channel"}'
```

Copy the `id`.

### 2g. Create and start the organizer conversation

```bash
curl -X POST http://localhost:3000/v1/conversations/from-type \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "eventSetup",
    "name": "Organizer Channel",
    "platforms": ["slack"],
    "topicId": "<id from 2f>",
    "properties": {
      "slackChannel": "C...",
      "slackWorkspace": "T...",
      "slackBotToken": "xoxb-...",
      "slackBotUserId": "U...",
      "botName": "Event Setup Bot"
    }
  }'

curl -X POST http://localhost:3000/v1/conversations/<conversation-id>/start \
  -H "Authorization: Bearer <token>"
```

### Verification

Send in `#event-setup-dev`:
- `"I want to setup a new event"` → bot replies "Event setup coming soon" ✓
- `"hello everyone"` → bot stays silent ✓

---

## Part 3: Production Deployment

### 3a. Add the signing secret to your production environment

Set `SLACK_SIGNING_SECRET` in your production environment variables (however your deployment manages secrets — Railway, Render, Heroku config vars, etc.). Same value as local.

### 3a-bis. Grant the bot access to private topics (optional)

The bot user is created automatically on first startup. For private topics, set `EVENT_SETUP_DEFAULT_TOPICS` in your production environment, or follow them once via `POST /v1/topics/follow` with a bot token (same curl as the local step above, pointed at your production URL).

### 3b. Register the production webhook URL with Slack

In your Slack app → **Event Subscriptions** → add a second URL entry (or replace the local one):
```
https://<your-production-domain>/v1/webhooks/slack
```

Slack will verify it against the running production server.

### 3c. Create a production Slack channel

1. Create a private channel (e.g. `#event-setup`)
2. Invite the bot: `/invite @<your-bot-name>`
3. Collect the Channel ID and Workspace ID the same way as local

### 3d. Get a bearer token

```bash
curl -X POST https://<your-production-domain>/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "<your-admin-email>", "password": "<your-password>"}'
```

### 3e. Create a topic

```bash
curl -X POST https://<your-production-domain>/v1/topics \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Event Setup", "description": "Parent topic for the organizer event setup channel"}'
```

### 3f. Create and start the organizer conversation

```bash
curl -X POST https://<your-production-domain>/v1/conversations/from-type \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "eventSetup",
    "name": "Organizer Channel",
    "platforms": ["slack"],
    "topicId": "<id from 3e>",
    "properties": {
      "slackChannel": "C...",
      "slackWorkspace": "T...",
      "slackBotToken": "xoxb-...",
      "slackBotUserId": "U...",
      "botName": "Event Setup Bot"
    }
  }'

curl -X POST https://<your-production-domain>/v1/conversations/<conversation-id>/start \
  -H "Authorization: Bearer <token>"
```

### Verification

Send in `#event-setup`:
- `"I want to setup a new event"` → bot replies "Event setup coming soon" ✓
- `"hello everyone"` → bot stays silent ✓
