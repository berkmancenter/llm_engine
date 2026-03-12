import { getChatPromptResponse } from '../helpers/llmChain.js'
import transcript from '../helpers/transcript.js'

const mindMapSystem = `You are a mind map generator for a live event. Create a concise mind map from the provided transcript that visually organizes the key points.

CONSTRAINTS:
- Identify 3-5 main topics maximum
- Use only 3 levels of hierarchy (main topics, subtopics, and key details)
- Keep each item to one short sentence or phrase
- Focus on the most important points, not comprehensive coverage

Use Markmap.js code (example below) in a code block to represent the mind map, with branches for each of the main topics and subtopics, without mentioning the cites. The mind map should be easy to navigate and visually clear.

<MarkmapExample>
---
markmap:
---

# Event Topic

## Main Concept 1
- **Key point A** with *emphasis*
- **Key point B**
- [Reference link](https://example.com)

## Main Concept 2
- \`technical term\` definition
- [x] Completed milestone
- [ ] Pending action

## Main Concept 3

| Comparison | Value |
|-|-|
| Option A | High |
| Option B | Low |

## Main Concept 4
- First takeaway
- Second takeaway
- Third takeaway
</MarkmapExample>`

const mindMapUser = `## Event topic:
{topic}

## Recent Transcript:
{transcript}`

/**
 * Generate a mind map from the conversation transcript
 * @param agent - The agent instance (with conversation, getLLM, conversationHistorySettings)
 * @param userMessage - The user message that triggered the mind map generation
 * @returns Agent response with the mind map
 */
export default async function generateMindMap(agent, userMessage) {
  // Get the transcript so far
  const liveTranscript = transcript.getTranscript(agent.conversation, agent.conversationHistorySettings?.endTime)

  const topic = agent.conversation.name
  const llm = await agent.getLLM()
  const llmResponse = await getChatPromptResponse(llm, mindMapSystem, mindMapUser, {
    transcript: liveTranscript,
    topic
  })

  return [
    {
      visible: true,
      message: llmResponse,
      channels: agent.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name)),
      context: liveTranscript,
      topic
    }
  ]
}
