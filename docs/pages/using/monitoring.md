# Monitoring and Reporting

LLM Engine provides some support for monitoring a live event and generating post-event reports for additional insight into agent performance.

## Langsmith integration

We integrate with [Langsmith](https://www.langchain.com/langsmith/observability) for real-time conversation tracing. To connect and use Langsmith, set the following environment variables in your `.env` file:

```
LANGSMITH_TRACING_V2=true
LANGSMITH_API_KEY=[Your API key]
# Optional
LANGSMITH_PROJECT=[any unique identifier]
```

When `LANGSMTIH_TRACING_V2` is set to true, Langsmith will report all agent interactions as traces in the Langsmith dashboard. You can inspect these traces to see user input and agent responses, as well as the context and conversation history that was provided to the agent. Langsmith also reports latency and token usage.

Traces can be manually annotated with feedback or configured to be automatically annotated with evaluators. Importantly, traces can be added to a dataset to support future evaluation and experimentation.

## LLM Engine reports

LLM Engine offers an endpoint to generate summary reports of a past conversation, including basic statistics like average number of interactions and a detailed history of all user and agent messages. The reporting endpoint is linked to the [experimentation feature](./experiments.md), but it is possible to label a past conversation as an experiment in order to generate a report.

### Creating an experiment from a past conversation

To create an experiment from a conversation, post the following body to the `/experiments` endpoint:

```
{
  "name": [conversation name],
  "baseConversation": [conversation id],
  "executedAt": [conversation start time in ISO8601 format, e.g. "2025-11-19T17:20:00.000Z" ]
}
```

The response will contain the ID of the new experiment, which can be used to generate a report

### Running a report

There are two types of reports for conversations: direct message and periodic.

#### Direct message reports

The direct message report is for agents like the Event Assistant that are used for direct user to agent communication only. The report prints the message history for each user interaction in the conversation. To run the report, make the following GET request: `/experiments/{{experimentId}}/results?reportName=directMessageResponses&format=text`

The response should look something like this:

```
Direct Message Agent Responses Report
===========================

Experiment: My Event
Experiment Time: 11/19/2025, 5:20:00 PM
Base Conversation ID: 123456789
Result Conversation ID: 123456789

===========================
Agent Name: Event Assistant
Total Users Messaged: 68
Total Users Responded: 32
Min Engagements Per User: 1
Max Engagements Per User: 24
Average Engagements Per User: 4.09375

---------------------------
**User: Steely Angelfish**

5:21:01 PM  Event Assistant: Hi! I'm the LLM Event Assistant. If you miss something, or want a clarification on something that’s been said during the event, you can DM me. None of your messages to me will be surfaced to the moderator or the rest of the audience.

5:21:05 PM  Steely Angelfish: What is this event about?

...

---------------------------
---------------------------
**User: Scholarly Babbler**

5:35:51 PM  Event Assistant: Hi! I'm the LLM Event Assistant. If you miss something, or want a clarification on something that’s been said during the event, you can DM me. None of your messages to me will be surfaced to the moderator or the rest of the audience.

5:42:19 PM  Scholarly Babbler: I just joined. What have I missed?

...
```

#### Periodic reports

The periodic report is for agents like the Back Channel that generate responses periodically, rather than on-demand in response to a user message. The report prints all user messages and agent responses within each time interval. To run the report, make the following GET request: `/experiments/{{defaultExperiment}}/results?reportName=periodicResponses&format=text`

The response should look something like this:

```
Periodic Agent Responses Report
===========================

Experiment: My Moderated Event
Generated: 9/10/2025, 12:20:00 PM
Unique Participants: 22

===========================
Agent Name: Back Channel Insights Agent

***Messages in time period: 12:31:27 PM - 12:33:27 PM***

12:32:39 PM  Blithe Belemnite: What is the speaker's definition of artificial intelligence?


**Agent Responses**

  Insights:

      Value: What is the speaker's definition of artificial intelligence?
      Comments:

          User: Blithe Belemnite
          Text: What is the speaker's definition of artificial intelligence?

...
```

More report types and formats other than text may be developed in the future.
