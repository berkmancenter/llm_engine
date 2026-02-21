# Experiments

LLM Engine provides a basic structure for running experiments against past conversations. Experiments are most useful in three situations:

1. You have modified the code of an agent and want to see how it now performs against a past conversation
2. You want to change something that is typically configured as a an agent property, such as the prompt or the model the agent uses (i.e. seeing how GPT-4o-mini might compare to GPT-4.1)
3. (not yet supported) You want to test a brand new agent against a past conversation

## Running an experiment against updated agent code

If you updated an agent that was previously used in a conversation, you can easily rerun the conversation through the new agent code and view the new responses. Use a retrieval endpoint to find the conversation and agent IDs, then POST the following body to `/experiments/`

```
{
    "name": "My Event",
    "baseConversation": "{{conversationId}}",
    "agentModifications": [
        {
            "agent": "{{agentId}}",
        }
    ]
}
```

## Running an experiment with experimental agent property values

To modify agent property values like prompt or llmModel, you can create an experiment with `experimentValues` properties. Use a retrieval endpoint to find the conversation and agent IDs, then POST the following body to `/experiments/`

```
{
    "name": "My Event",
    "baseConversation": "{{conversationId}}",
    "agentModifications": [
        {
            "agent": "{{agentId}}",
            "experimentValues": {
                "llmTemplates": {
                    "system": "Do something different than the last prompt I gave you",
                },
                "llmPlatform": "openai",
                "llmModel": "gpt-4o-mini"
            }
        }
    ]
}
```

## Viewing experiment results

There are three types of reports for experiments: direct message, user metrics, and periodic.

#### Direct message reports

The direct message report is for agents like the Event Assistant that are used for direct user to agent communication only. The report prints the message history for each user interaction in the conversation. To run the report, make the following GET request: `/experiments/{{experimentId}}/results?reportName=directMessageResponses&format=text`

You can also specify additional channels to check with the queryParameter additionalChannels. For example, `additionalChannels=chat` will print summary statistics and detailed history of all messages in the group chat channel.

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

#### User Metric reports

The User Metrics report provides detailed counts of messages sent per user in CSV format. To run the report, make the following GET request: `/experiments/{{experimentId}}/report?reportName=userMetrics&format=csv`

You can also specify additional channels to check with the queryParameter additionalChannels. For example, `additionalChannels=chat` will include the count of messages sent on the group chat channel.

The response should look something like this:

```
Pseudonym,Direct Messages,chat
Abiotic Venus,0,0
Absolute Tomato,0,0
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
