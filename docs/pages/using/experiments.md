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

See [LLM Engine Reports] (./monitoring.md) for instructions on running a report to view the results of the experiment.
