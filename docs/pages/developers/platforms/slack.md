## Optional: Set up Slack integration

LLM Engine integrates with Slack to allow agents to participate in Channel discussions or direct messages. Follow these steps to create a Slack app that can be invited to discussions in a workspace.

### One Time Setup - Create the app in Slack

These instructions roughly follow the steps outlined in Slack's [Getting Started Guide](https://api.slack.com/quickstart).

Get a free Slack Developer sandbox and then complete Step 1 in the Guide, `Create an App`. We named our app LLM Engine, but you can name yours anything.

#### Request Scopes

Follow Step 2 `Requesting Scopes` to request the following Bot Token Scopes:

- chat:write
- chat:write.public
- channels:read

#### Enable Messaging from Messages Tab

Check the `Allow users to send Slash commands and messages from the messages tab` box under the `App Home` tab to allow users to DM the app.

#### Install and Authorize the App in your Workspace

Follow Step 3 `Installing and Authorizing the App`

NOTE: currently you do need to invite the app to a channel in order for agents to participate

`/invite @LLM Engine` (or whatever you named the app when you created it)`

#### Configure the app for event listening

Follow Step 4 `Configuring the app for event listening.` Set the request URL to the following address of your running LLM Engine server:
`https://[base URL]/v1/webhooks/slack`

Subscribe to the following bot events

- message.channels
- message.groups
- message.im

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
5. Create a `Conversation` with the desired channels and provide the Slack Channel ID, Workspace ID, and Bot Token in the Slack `adapter config`

Example conversation body:

```
{
    "name": "Should plastic water bottles be banned?",
    "topicId": "{{defaultTopic}}",
    "channels": [ { "name": "moderator"}, { "name": "participant"}],
    "adapters": [ {"type": "slack", "config" : {"channel": "C08US6FL6DV", "workspace: "T123494", botToken:[token],
        "chatChannels": [ { "name": "playfulSlack", "direction": "both"}]}}]
}
```

**NOTE: A unique Slack workspace and channel combination can only be associated with one active Conversation**

6. Post a message to the Slack Channel. Any agents configured on the `Conversation` should receive and send messages on their typical channels.

If you wish to support DMs between users and agents, you must configure a separate Conversation for all DMs. **You can only have one such Conversation active at a time.** Private communication between a user and the Slack app happens on a dedicated channel (different for each user). Therefore, you must use the keyword 'direct' for channel name, to signal that the conversation should process all direct messages.

Example conversation body:

```
{
    "name": "A chat",
    "topicId": "{{defaultTopic}}",
    "enableDMs": ['agents'],
    "agentTypes": [agents],
    "adapters": [ {"type": "slack", "config" : {"channel": "direct", "workspace: "T123494", botToken:[token],
        "dmChannels": [{ "direct": true, "agent": "playfulPerMessage", "direction": "both"}]}}]
}
```
