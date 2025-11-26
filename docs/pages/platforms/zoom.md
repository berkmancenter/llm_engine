## Zoom integration

LLM Engine can integrate with Zoom! It supports:

- live transcription
- sending and receiving direct messages

Zoom integration requires the use of [Recall.ai](https://recall.ai), a third party service.

### Set up Recall.ai

We provide a Zoom adapter that saves real-time transcription of a Zoom meeting to LLM Engine. We use the meeting bot API provided by Recall.ai to connect to Zoom. Follow these steps to integrate with Recall:

#### One Time Setup

1. Complete Step 1 of [these instructions](https://beta-docs.recall.ai/docs/step-1-create-a-zoom-marketplace-app) to create a Zoom marketplace app and connect it to Recall.
2. In Zoom Marketplace, Set up Zoom event subscriptions in your app to receive meeting started and ended events. Choose Webhook method and set the event notification endpoint URL to [baseUrl]/v1/webhooks/zoom
3. Set the four Recall environment variables and Zoom event subscription variable in `.env`

```
RECALL_API_KEY
RECALL_BASE_URL: the URL used to connect to your Recall account
RECALL_TOKEN: can be anything. Sent to Recall to use as a query param for authentication when it calls back to our webhooks
RECALL_BASE_URL: The URL Recall should use to send events to this server, e.g. a static ngrok domain if running locally
ZOOM_SECRET_TOKEN: the secret token found in your app configuration in the Zoom marketplace
```

#### Zoom Webinar One Time Setup

Recall bots can join Zoom webinars as well as meetings, but they must be added to the webinar as panelists. To enable this, create a dedicated email address for your bots. Then update this environment variable in `.env`

```
ZOOM_WEBINAR_USER_EMAIL=[bot email address]
```

### Using LLM Engine in a Zoom Meeting

1. Ensure ngrok tunnel is running (for local development) or LLM Engine is otherwise remotely accessible from the wider internet.
2. Schedule a Zoom meeting and copy the full invite link, including any passcodes and meeting IDs.
3. Create a `Conversation` with a `transcript` channel and provide the `meetingUrl` in the Zoom `adapter config`.

Example conversation body:

```
{
    "name": "Should plastic water bottles be banned?",
    "topicId": "{{defaultTopic}}",
    "channels": [ { "name": "transcript"}],
    "adapters": [ {"type": "zoom", "config" : {"meetingUrl": "{{ZOOM_MEETING_URL}}"}}]
}
```

**NOTE: A unique Zoom meeting URL can only be associated with one active Conversation**

#### Zoom Webinars

You must add the bot as a panelist when scheduling a webinar in order to allow recording. Invite the bot to the webinar as a panelist using the email address you created in the one-time setup. **Be sure to use the specific Zoom invite link sent to the panelist bot as the `meetingUrl`.** You can get this link by copying the invitation when you add the panelist. If your webinar requires registration, the bot user does NOT have to register.

Note: Webinar participants in a Zoom session cannot DM a single panelist, so agents that interact through DMs in Zoom meetings will not function the same in a webinar.

#### Data Retention

By default, Zoom meeting recordings are retained on the Recall server for one hour after the meeting. You can specify a different retention policy in your adapter config. Set retention to null for zero data retention (but note, this will impact your ability to debug Recall issues). Otherwise, see [Recall documentation](https://docs.recall.ai/docs/storage-and-playback) for supported options.

Example setting data retention to four hours:

```
{
    "name": "Should plastic water bottles be banned?",
    "topicId": "{{defaultTopic}}",
    "channels": [ { "name": "transcript"}],
    "adapters": [ {"type": "zoom", "config" : {"meetingUrl": "{{ZOOM_MEETING_URL}}",     "retention": {"type": "timed",hours: 4}}, "audioChannels": [{"name": "transcript"}]}]
}
```

4. Start your Zoom meeting. After a minute or two, LLM Engine should join the meeting and ask for recording permission.
5. Grant permission to record and real-time transcription should start.

## Enabling Direct Messages

If you wish to enable direct messages between agents and users, you must set the `enableDMs": ["agents"]` property during Conversation creation. You must also specify a `dmChannel` in the `Adapter` configuration for each agent that should receive DMs.

```
{
"name": "Should plastic water bottles be banned?",
"topicId": "{{defaultTopic}}",
"enableDMs": ["agents"]
"channels": [ { "name": "transcript"}],
"adapters": [ {"type": "zoom", "config" : {"meetingUrl": "{{ZOOM_MEETING_URL}}"},
    "dmChannels": [{"direct": true, "agent": "eventAssistant", "direction": "both"}],
    "audioChannels": [{"name": "transcript"}]}]
}
```

If you do not need transcription, remove the `transcript` channel from the configuration.
