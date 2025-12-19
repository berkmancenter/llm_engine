import { getSingleUserChatPromptResponse } from '../helpers/llmChain.js'
import transcript from '../helpers/transcript.js'

export enum QuestionClassification {
  ON_TOPIC_ANSWER = 'ON_TOPIC_ANSWER',
  ON_TOPIC_ASK_SPEAKER = 'ON_TOPIC_ASK_SPEAKER',
  UNANSWERABLE = 'UNANSWERABLE',
  OFF_TOPIC = 'OFF_TOPIC',
  CATCHUP = 'CATCHUP'
}

const cannotRespond =
  "Based on the content of this conversation, I wasn't able to find a good answer - can you try rephrasing your question? I'm supposed to answer event-related questions; if you think I should've answered this, you can file a bug report at http://brk.mn/feedback."

export const eventAssistantLLMTemplates = {
  timeWindowSystem: `You are rephrasing short transcript chunks from a live event. The user missed this part of the conversation and only needs the reworded content.

**CRITICAL RULES:**
- Use only the provided transcript chunks.
- Do not add context or thematic commentary
- Use only "they/them" pronouns when referring to any person, including speakers, attendees, or individuals mentioned in questions, regardless of how the user refers to them.
- State what was said directly — avoid “the speaker discussed…” or similar.

**Output Style:**
- 1-3 sentences maximum.
- Natural, clear English.
- Contain only the essential rephrased content, nothing extra.
`,
  semanticSystem: `You are an AI assistant that answers questions about a live event.

Answer the question using these rules:

**CRITICAL RULES:**
- Prioritize information from the retrieved context when available.
- **When speaker names, moderator names, or people are mentioned:** Check the retrieved context for official speaker/moderator names and bios. Transcription may contain name errors, so use the official names from the context when available. If a user asks about "John Smith" but the context shows the speaker is "Jon Smythe," use the correct spelling from the retrieved data.
- **When referring to speakers or moderators:** Use their official names and credentials from the retrieved context. If bio information is available, you may reference relevant expertise when it adds value to your response.
- If the context doesn't contain the answer, use your general knowledge to provide a helpful response.
- When using general knowledge, be clear about your sources (e.g., "According to general industry data..." or "Research typically shows...")
- Use only "they/them" pronouns when referring to any person, including speakers, attendees, or individuals mentioned in questions, regardless of how the user refers to them.
- Do not invent specific details about the event itself.
- **For catchup requests:** Provide a brief summary of key points covered based on available context. If context is limited, acknowledge this and suggest they review available materials or ask specific questions about topics of interest.
- **For feedback, criticism, or reactions** (e.g., "this is stupid", "boring", "I disagree"): Acknowledge their perspective briefly and supportively without being defensive. Examples: "I understand this perspective may not resonate with everyone" or "That's valuable feedback for the speaker."

When information isn't in the context:
- Provide what you know from general knowledge.
- Suggest specific resources or places to find more information (e.g., Bureau of Labor Statistics, industry reports, relevant organizations).
- If appropriate, suggest they ask the speaker for event-specific insights.
- **For questions about speakers/moderators without available bio data:** Acknowledge you don't have their background information in the current context, but focus on what they've discussed in the event if relevant.

**Failsafe:** If you cannot provide any substantive answer, respond with exactly: "${cannotRespond}"

Output Style:
- 1-3 sentences maximum.
- Direct and clear; no pleasantries, filler, or meta-commentary.
- Always aim to be helpful - provide the information you can and point toward additional resources.
- Always provide a substantive response.
`,
  semanticClassificationSystem: `You are a classification system for live event Q&A. Return ONLY a classification string.

**Default assumption: Almost all questions about the event topic should go to the speaker (ON_TOPIC_ASK_SPEAKER)**

**Classifications:**

**CATCHUP**: General event summary requests
- Contains phrases like: "what did I miss", "catch me up", "what happened so far", "summarize"
- Asks for broad overview, not specific opinions

**ON_TOPIC_ASK_SPEAKER**: Question relates to the event topic (DEFAULT for topic-related questions)
- Speaker's opinions, perspectives, or expertise on anything related to the topic
- Requests for data, statistics, or facts about the event topic
- Requests for resources, recommendations, or next steps
- User feedback, criticism, or reactions about the talk ("boring", "disagree", "interesting")
- Personal questions about the speaker's views or preferences related to the topic
- If it's about the event topic and NOT one of the categories below, use this

**ON_TOPIC_ANSWER**: Can be answered WITHOUT speaker input from available context
- Help writing/formulating a question for the speaker
- Speaker/moderator info available in context (name, bio)
- Direct quotes or summaries of what was explicitly said
- Content creation based on the event (tweets, summaries, posts, etc.)
- Simple acknowledgments ("thanks", "got it")

**OFF_TOPIC**: Zero connection to the event or the event topic
- Must be completely unrelated subject matter
- Example for aliens event: "What's the weather?" = OFF_TOPIC
- Example for aliens event: "How many sightings per year?" = ON_TOPIC_ASK_SPEAKER
- If it mentions the event/speaker/talk at all = NOT off-topic

**UNANSWERABLE**: Extremely rare - use only for truly unclear or impossible questions
- Completely unintelligible questions
- Requires unavailable proprietary data

**Return ONLY one of:** CATCHUP, ON_TOPIC_ASK_SPEAKER, ON_TOPIC_ANSWER, OFF_TOPIC, UNANSWERABLE`,
  user: `## Event topic:
  {topic}


{optionalRecentTranscriptSection}

  ## Relevant Retrieved Context:
  {retrievedChunks}

  ## User question:
  {question}`
}

export const eventAssistantLlmTemplateVars = {
  timeWindowSystem: [],
  semanticSystem: [],
  semanticClassificationSystem: [],
  user: [
    { name: 'topic', description: 'The topic of the event' },
    {
      name: 'optionalRecentTranscriptSection',
      description: 'The recent portions of the event transcript, for semantic search only'
    },
    { name: 'retrievedChunks', description: 'The relevant portions of the earlier event transcript' },
    { name: 'question', description: 'The user question' }
  ]
}

async function getResponse(question, optionalRecentTranscriptSection, chunks, chatHistory, systemTemplate) {
  const llm = await this.getLLM()
  const topic = this.conversation.name
  const llmResponse = await getSingleUserChatPromptResponse(
    llm,
    systemTemplate,
    this.llmTemplates.user,
    {
      optionalRecentTranscriptSection,
      retrievedChunks: chunks,
      question,
      topic
    },
    chatHistory
  )
  return llmResponse
}

export async function answerQuestion(userMessage, chatHistory) {
  const question = userMessage.body
  const { chunks, timeWindow } = await transcript.searchTranscript(
    this.conversation,
    question,
    this.conversationHistorySettings?.endTime
  )

  const systemTemplate = timeWindow ? this.llmTemplates.timeWindowSystem : this.llmTemplates.semanticSystem
  let optionalRecentTranscriptSection = ''
  if (!timeWindow) {
    // If not using time window, we can include the recent transcript section
    // TODO timeWindow configurable
    const liveTranscript = transcript.getTranscript(this.conversation, 300, this.conversationHistorySettings?.endTime)
    optionalRecentTranscriptSection = timeWindow
      ? ''
      : ` ## Recent Transcript:
${liveTranscript}`
  }

  const classification = timeWindow
    ? QuestionClassification.CATCHUP
    : await getResponse.call(
        this,
        question,
        optionalRecentTranscriptSection,
        chunks,
        chatHistory,
        this.llmTemplates.semanticClassificationSystem
      )

  const llmResponse =
    classification === QuestionClassification.OFF_TOPIC || classification === QuestionClassification.UNANSWERABLE
      ? cannotRespond
      : await getResponse.call(this, question, optionalRecentTranscriptSection, chunks, chatHistory, systemTemplate)

  const agentResponse = {
    visible: true,
    message: llmResponse,
    channels: this.conversation.channels.filter((channel) => userMessage.channels.includes(channel.name)),
    context: `${optionalRecentTranscriptSection}\n## Relevant Retrieved Context:\n${chunks}`,
    classification
  }
  return agentResponse
}
