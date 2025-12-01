# Using LLM Engine

## Creating a Conversation

Once you have LLM Engine up and running, the first thing to do is create a Conversation. Since LLM Engine is a headless service, you can interact with the `conversations` API through any REST client such as Postman or directly through the OpenAPI swagger endpoint on your locally running server, at http://localhost:3000/v1/docs. If you wish to use a Front End to create and configure a Conversation, we recommend our open source [Nextspace app](https://github.com/berkmancenter/nextspace).

The easiest way to create a conversation is to use the `/conversations/from-type` endpoint, which allows you to specify only the minimal properties needed to create a conversation that uses either our Event Assistant or Back Channel production agents.

Here is an example conversation that uses the Event Assistant:

```
{
    "name": "Where are all the aliens?",
    "topicId": "{{topicId}}",
    "type": "eventAssistant",
    "platforms": ["zoom"],
    "properties": {"zoomMeetingUrl": "{{ZOOM_MEETING_URL}}"}
}
```

**Note: These agents require Zoom for transcription, so you must provide a valid Zoom Meeting URL.** See our [Zoom guide](../platforms/zoom.md) for more information.

## Monitoring a Conversation

If you would like to monitor or run reports on agent responses and performance during a conversation, see our [Monitoring and Reporting guide](./monitoring.md).

## Experimenting with Agents

If you would like to experiment with an existing agent by modifying its prompts or changing its model, see our [Experimentation guide](./experiments.md).
