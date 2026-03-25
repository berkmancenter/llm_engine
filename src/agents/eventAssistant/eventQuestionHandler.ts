import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatMultiUserConversationHistory, formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import User from '../../models/user.model/user.model.js'
import logger from '../../config/logger.js'
import { IChannel } from '../../types/index.types.js'
import config from '../../config/config.js'

import { getModelChat, classificationLLMPlatform, classificationLLMModel } from '../helpers/getModelChat.js'
import { personalitySection } from '../helpers/agentPersonality.js'

export enum QuestionClassification {
  ON_TOPIC_ANSWER = 'ON_TOPIC_ANSWER',
  ON_TOPIC_ASK_SPEAKER = 'ON_TOPIC_ASK_SPEAKER',
  UNANSWERABLE = 'UNANSWERABLE',
  OFF_TOPIC = 'OFF_TOPIC',
  CATCHUP = 'CATCHUP'
}

export const cannotRespond =
  "Hmm, I don't have a great answer to that one. Can you try rephrasing it? I'm best at event-related questions. And if you think this was on me, a bug report at http://brk.mn/feedback would be much appreciated!"

function buildLLMTemplates(personalityName?: string | null) {
  const personalityContent = personalityName ? personalitySection : ''

  return {
    timeWindowSystem: `You are rephrasing short transcript chunks from a live event. The user missed this part of the conversation and only needs the reworded content.

${personalityContent}

**CRITICAL RULES:**
- Use only the provided transcript chunks.
- Do not add context or thematic commentary
- Use only "they/them" pronouns when referring to any person, including speakers, attendees, or individuals mentioned in questions, regardless of how the user refers to them.
- State what was said directly — avoid "the speaker discussed…" or similar.

**Output Style:**
- 1-3 sentences maximum.
- Natural, clear English.
- Contain only the essential rephrased content, nothing extra.
`,
    semanticSystem: `You are an AI assistant that answers questions about a live event.

${personalityContent}

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

**ON_TOPIC_ASK_SPEAKER**: Question relates to the event topic (DEFAULT for topic-related questions), OR helpful for the speaker to understand audience positive or negative sentiment.
Important! When deciding between ON_TOPIC_ASK_SPEAKER and ON_TOPIC_ANSWER, bias towards ON_TOPIC_ASK_SPEAKER.
- Speaker's opinions, perspectives, or expertise on anything related to the topic
- Requests for data, statistics, or facts about the event topic
- Requests for resources, recommendations, or next steps
- User feedback, criticism, or reactions about the talk (e.g. "boring", "disagree", "interesting")
- Personal questions about the speaker's views or preferences related to the topic
- If it's about the event topic and NOT one of the categories below, use this

**ON_TOPIC_ANSWER**: Can be answered authoritatively and exhaustively WITHOUT speaker input from available context and clearly NOT helpful for the speaker to understand audience sentiment.
- Help writing/formulating a question for the speaker
- Speaker/moderator info available in context (name, bio)
- Direct quotes or summaries of what was explicitly said
- Content creation based on the event (tweets, summaries, posts, etc.)
- Simple acknowledgments ("thanks", "got it")

**OFF_TOPIC**: Zero connection to the event or the event topic, or an entirely irrelevant request or instruction
- Must be completely unrelated subject matter
- Example for aliens event: "What's the weather?" = OFF_TOPIC
- Example for aliens event: "How many sightings per year?" = ON_TOPIC_ASK_SPEAKER
- If it mentions the event/speaker/talk at all = NOT off-topic

**UNANSWERABLE**: Extremely rare - use only for truly unclear or impossible questions
- Completely unintelligible questions
- Requires unavailable proprietary data

**Output Format:**
**Return ONLY a single string - one of:** CATCHUP, ON_TOPIC_ASK_SPEAKER, ON_TOPIC_ANSWER, OFF_TOPIC, UNANSWERABLE
Do NOT provide any explanation or additional text.`,
    visualClassificationSystem: `You classify whether a question/answer pair would benefit from a visual representation (diagram, illustration, chart, etc.).

**Core principle:** Visuals excel at showing relationships between multiple elements. If the answer involves multiple concepts, steps, or components that connect or relate to each other, it likely benefits from visualization.

**Return VISUAL if the answer includes:**
- Multiple elements with relationships between them (sequences, hierarchies, comparisons, dependencies, cause-effect)
- Something inherently visual (appearance, layout, physical structure, spatial relationships)
- Process-oriented questions ("how to", "what are the steps", "what's the process")

**Return TEXT if:**
- Single simple concept with no relationships to illustrate
- Pure opinion, philosophy, or subjective experience
- Very short answer (< 2 sentences) or simple acknowledgment
- The answer is primarily a quote or summary of what was said

**Output Format:**
Return ONLY: VISUAL or TEXT
Do NOT provide any explanation or additional text.`,
    visualClassificationUser: `## Question:
{question}

## Answer:
{answer}

Would this benefit from a visual representation?`,
    user: `## Event topic:
  {topic}

  ## Context:
  {context}

  ## User question:
  {question}`
  }
}

export const eventAssistantLLMTemplates = buildLLMTemplates('sarcastic-expert')

export const eventAssistantLlmTemplateVars = {
  timeWindowSystem: [],
  semanticSystem: [],
  semanticClassificationSystem: [],
  visualClassificationSystem: [],
  visualClassificationUser: [
    { name: 'question', description: 'The user question' },
    { name: 'answer', description: 'The generated answer' }
  ],
  user: [
    { name: 'topic', description: 'The topic of the event' },
    {
      name: 'context',
      description: 'The context for answering the question - may include recent transcript and/or relevant retrieved chunks'
    },
    { name: 'question', description: 'The user question' }
  ]
}

const funFactSystemTemplate = `You create short, fun facts about pseudonyms. The pseudonym is in the form "adjective noun". Create a 1 sentence fun fact that is factual about the noun, but can be playful about the adjective part. Makes sure your answers are safe for work.
  **IMPORTANT** Always start the sentence with the phrase 'Fun Fact about your pseudonym:'`
const funFactUserTemplate = 'Create a fun fact about the pseudonym: {pseudonym}'

async function getResponse(question, context, chatHistory, topic, systemTemplate) {
  const llm = await this.getLLM()
  const llmResponse = await getChatPromptResponse(
    llm,
    systemTemplate,
    this.llmTemplates.user,
    {
      context,
      question,
      topic
    },
    chatHistory
  )
  return llmResponse
}

async function shouldGenerateVisual(question, classification, llmResponse, templates) {
  // Auto-reject certain classifications
  if (classification === QuestionClassification.OFF_TOPIC || classification === QuestionClassification.UNANSWERABLE) {
    logger.debug('Skipping visual generation: question is off-topic or unanswerable')
    return false
  }

  // Auto-reject simple/short responses (acknowledgments, etc.)
  if (llmResponse.length < 50 || llmResponse === cannotRespond) {
    logger.debug('Skipping visual generation: response too short or cannot respond')
    return false
  }

  // Use LLM to classify if visual would help
  try {
    // Use classification LLM for potential latency benefits
    const classificationPlatform = this.agentConfig?.classificationPlatform || classificationLLMPlatform
    const classificationModel = this.agentConfig?.classificationModel || classificationLLMModel
    const llm = await getModelChat(classificationPlatform, classificationModel)

    // Truncate very long answers to reduce tokens (first 1000 chars usually sufficient for classification)
    const truncatedAnswer = llmResponse.length > 1000 ? `${llmResponse.substring(0, 1000)}...` : llmResponse
    const visualClassification = await getChatPromptResponse(
      llm,
      templates.visualClassificationSystem,
      templates.visualClassificationUser,
      { question, answer: truncatedAnswer }
    )

    const result = visualClassification.trim() === 'VISUAL'
    logger.debug(`Visual classification result: ${visualClassification.trim()} (generating: ${result})`)
    return result
  } catch (error) {
    logger.error(`Failed to classify visual appropriateness: ${error.message}`)
    return false // Default to no visual on error
  }
}

export async function generatePseudonymFunFact(channel) {
  // Find the user participant (not the agent)
  const userParticipantId = channel.participants.find(
    (participantId: string) => participantId.toString() !== this._id.toString()
  )
  const user = await User.findById(userParticipantId)
  const activePseudonym = user?.pseudonyms?.find((p) => p.active)

  if (!activePseudonym?.pseudonym) {
    logger.debug(`No active pseudonym found for user ${user?._id} on channel ${channel.name}, cannot generate fun fact.`)
    return null
  }

  const llm = await this.getLLM()

  const funFact = await getChatPromptResponse(llm, funFactSystemTemplate, funFactUserTemplate, {
    pseudonym: activePseudonym.pseudonym
  })

  return funFact
}

export async function answerQuestion(userMessage, conversationHistory, options?) {
  const chatHistory = userMessage?.channels?.includes('chat')
    ? formatMultiUserConversationHistory(conversationHistory)
    : formatSingleUserConversationHistory(conversationHistory)

  const question = userMessage.body

  // Determine which personality to use (if any)
  // agentConfig.personality takes precedence
  // If not set, fall back to config.enableAgentPersonality (boolean) - true maps to 'sarcastic-expert', false to null
  // Determine which personality to use (if any)
  // agentConfig.personality takes precedence
  // If not set, fall back to config.enableAgentPersonality (boolean) - true maps to 'sarcastic-expert', false to null
  let personalityName: string | null = null
  if (this.agentConfig?.personality !== undefined) {
    personalityName = this.agentConfig.personality
  } else if (config.enableAgentPersonality) {
    personalityName = 'sarcastic-expert'
  }

  // Get the appropriate templates based on personality setting
  const templates = buildLLMTemplates(personalityName)

  // Use provided context from options if available, otherwise search transcript
  let contextString: string
  let promptType = options?.promptType // 'timeWindow' or 'semantic'

  if (options?.context) {
    // Use provided context string directly
    contextString = options.context
  } else {
    // Normal flow - search transcript
    const searchResult = await transcript.searchTranscript(
      this.conversation,
      question,
      this.conversationHistorySettings?.endTime
    )
    const { chunks, timeWindow } = searchResult

    // Determine prompt type from search result if not provided
    if (!promptType) {
      promptType = timeWindow ? 'timeWindow' : 'semantic'
    }

    if (timeWindow) {
      // For time window searches, use only the chunks
      contextString = chunks
    } else {
      // For semantic searches, include recent transcript and retrieved chunks
      const liveTranscript = transcript.getTranscript(this.conversation, 300, this.conversationHistorySettings?.endTime)
      contextString = `## Recent Transcript:
${liveTranscript}

## Relevant Retrieved Context:
${chunks}`
    }
  }

  // Default to semantic if no prompt type specified
  const isTimeWindow = promptType === 'timeWindow'
  const systemTemplate = isTimeWindow ? templates.timeWindowSystem : templates.semanticSystem

  const topic = options?.topic || this.conversation.name

  const classification = isTimeWindow
    ? QuestionClassification.CATCHUP
    : await getResponse.call(this, question, contextString, chatHistory, topic, templates.semanticClassificationSystem)

  const llmResponse =
    classification === QuestionClassification.OFF_TOPIC || classification === QuestionClassification.UNANSWERABLE
      ? cannotRespond
      : await getResponse.call(this, question, contextString, chatHistory, topic, systemTemplate)

  const responseChannels = this.conversation.channels.filter((channel: IChannel) =>
    userMessage.channels.includes(channel.name)
  )
  let parentMessageId
  let responseMessage = llmResponse

  // Check if visual generation should happen (either forced via /visual or user preference)
  const user = await User.findById(userMessage.owner)
  const forceVisual = options?.forceVisual === true

  if (forceVisual || user?.preferences?.visualResponse) {
    let shouldGenerate = false

    if (forceVisual) {
      logger.debug('Visual generation forced via /visual command')
      // For /visual command, always generate unless it's an error response
      // User explicitly requested visual, so respect their intent
      shouldGenerate = llmResponse !== cannotRespond
    } else {
      logger.debug(`User ${user!._id} has visual response preference enabled`)
      // Classify if this question/answer would benefit from a visual
      shouldGenerate = await shouldGenerateVisual.call(this, question, classification, llmResponse, templates)
    }

    if (shouldGenerate) {
      logger.debug(`Adding image-gen channel to response${forceVisual ? ' (forced)' : ''}`)
      // Add image-gen channel to the response
      const imageGenChannel = this.conversation.channels.find((channel: IChannel) => channel.name === 'image-gen')
      if (imageGenChannel) {
        responseChannels.push(imageGenChannel)
        // Set parent to the original question so imageGenerator can use it
        parentMessageId = userMessage._id
        // Add visual generation indicator to the message
        responseMessage = `${llmResponse}\n\n\n\n**🎨 Generating visual...**`
      } else {
        logger.warn('image-gen channel not found on conversation')
      }
    }
  }

  const agentResponse = {
    visible: true,
    message: responseMessage,
    messageType: 'text',
    channels: responseChannels,
    ...(parentMessageId && { parent: parentMessageId }),
    context: contextString,
    classification,
    promptType,
    topic
  }
  return agentResponse
}
