## Adapters

LLM Engine can be connected to external systems through the use of adapters and their associated webhooks. We currently provide two adapters: [Zoom](../platforms/zoom.md) and [Slack](platforms/slack.md). This guide explains how to add more!

There are two components to an adapter: the adapter itself and the webhook handler that routes communication to the adapter.

> While we have a WebSocket interface to LLM Engine, we do not yet support using it to communicate with external systems through adapters.

### Define an Adapter

Adapters contain the core functionality for sending messages to and receiving messages from the external system. They essentially act as translators of both `Message` and `User` information and they also contain the logic needed to send a message to an external system or to establish an initial connection.

Follow the steps below to add a new adapter.

1. Create the file `src/handlers/[adapterName].ts`
2. Implement the following methods, specific to the external system's data formats. See our [Zoom](../platforms/zoom.md) and [Slack](platforms/slack.md) adapters for examples.

NOTE: any properties specific to an individual `Conversation` can be stored in the Adapter's `config` property for reuse.

```

  start()  // optional logic to execute when conversation starts

  stop()  // optional logic to execute when conversation stops

  // translates received messages to appropriate format for LLM Engine to process
  receiveMessage(message: Record<string, unknown>): AdapterMessage[]

  sendMessage(message: IMessage) // sends message to external system

  validateBeforeUpdate() // optional validation needed when conversation is created

  // optional code to translate participant information into an LLM Engine user
  participantJoined(participant: Record<string, unknown>): AdapterUser
```

3. Add your adapter to `src/adapters/index.ts`

### Define a Webhook Handler

All incoming requests to LLM Engine should go through a webhook with URL in the format: [baseURL]/webhooks/[adapterName], where `adapterName` reflects the name of the external system (i.e. Zoom, Slack, etc.)

The `webhookController` routes all webhook calls to the appropriate handler for the calling system. Follow the steps below to add a new webhook handler.

1. Create the file `src/handlers/[adapterName].ts`
2. Add the following method, which should call `webhookService` to process valid events. Currently we support events of type `receiveMessage` and `participantJoined`.

```
const handleEvent = async (req, res) => {
   // process the request payload specific to your system
   // ultimately you need to find the Adapter through a unique
   // set of options specific to your system

   // This example uses botId from payload and an internal
   // conversation ID configured as a URL query param
   const conversation = await Conversation.findOne({ _id: conversationId }).populate('adapters').exec()
   if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
   }
   const botId = req.body.data.bot.id
   const zoomAdapter = conversation.adapters?.find((adapter) =>   adapter.type === 'zoom' && adapter.config.botId === botId)
  if (!zoomAdapter) {
    throw new ApiError(httpStatus.NOT_FOUND, `No Zoom adapter with botId ${botId} configured for this conversation`)
  }
  if (event === 'transcript.data' || event === 'participant_events.chat_message') {
    await webhookService.receiveMessage(zoomAdapter, req.body)
  } else {
    await webhookService.participantJoined(zoomAdapter, req.body.data.data.participant)
  }
  res.status(httpStatus.OK).send('ok')
}
```

3. Add this method to perform any verification or authorization (we recommend doing so whenever possible). This will get called prior to invoking `handleEvent`.

```
const middleware = async (req, res, next) => {

  try {
    // validate signing secrets, URL tokens, etc.
    next()
  } catch (err) {
    next(err)
  }
}
```

4. Add your handler to `src/handlers/index.ts`

### Try it Out

Create a `Conversation` that uses your new Adapter. This can be done through the `/conversations` endpoint. See OpenAPI documentation when running the app locally at the route `v1/docs` for details. The remainder of this section covers various payloads to use when creating the `Conversation`.

All `Messages` in LLM Engine have one or more `Channels` defined that control access. Your Adapter must be configured to place messages received from the external system onto specific channels and/or send messages on specific channels to an external system.

The `dmChannels`, `audioChannels`, and `chatChannels` adapter properties define how the adapter routes an LLM Engine message in a given Conversation.

These channels should specify a Direction, either `incoming`, `outgoing`, or `both`. The default direction is `incoming`.

- Incoming: messages from the external system should be created in LLM Engine with these channels
- Outgoing: LLM Engine messages with these channels should be sent to the external system
- Both: these channels represent two-way communication

** Be sure to include any channels you use in the `channels` property of the Conversation as well**

If your external system supports transcription, configure the audioChannels property as below. NOTE: _all transcripts must be placed on a channel named `transcript`._ We may support additional channel names in the future.

Example `Conversation` payload using transcription:

```
{
    "name": "Should plastic water bottles be banned?",
    "topicId": "{{defaultTopic}}",
    "channels": [ { "name": "transcript"}],
    "adapters": [ {"type": "[adapterName]", "config" : {"customProp": "customValue"}, "audioChannels": [{"name": "transcript"}]}]
}

```

For chat, you can send/receive on group channels using `chatChannels`

Example `Conversation` payload using a general chat channel:

```
{
    "name": "Should plastic water bottles be banned?",
    "topicId": "{{defaultTopic}}",
    "channels": [ { "name": "participant"}],
    "adapters": [ {"type": "[adapterName]", "config" : {"customProp": "customValue"}, "chatChannels": [{"name": "participant", direction: "both"}]}]
}
```

If you wish to enable direct messages between agents and users, you must set the `enableDMs": ["agents"]` property during Conversation creation. You must also specify a `dmChannel` for each agent that should receive DMs.

```
{
"name": "Should plastic water bottles be banned?",
"topicId": "{{defaultTopic}}",
"enableDMs": ["agents"]
"channels": [ { "name": "participant"}],
"adapters": [ {"type": "[adapterName]", "config" : {"customProp": "customValue"},
    "dmChannels": [{"direct": true, "agent": "eventAssistant", "direction": "both"}]}]
}
```
