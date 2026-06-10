import { getChatPromptResponse, getAgentStructuredResponse } from '../helpers/llmChain.js'
import { formatMultiUserConversationHistory, formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import rag from '../helpers/rag.js'
import User from '../../models/user.model/user.model.js'
import logger from '../../config/logger.js'
import { IChannel } from '../../types/index.types.js'
import config from '../../config/config.js'

import { getModelChat, classificationLLMPlatform, classificationLLMModel } from '../helpers/getModelChat.js'
import { personalitySection } from '../helpers/agentPersonality.js'
import { getTools } from '../tools/registry.js'
import {
  buildEventAssistantToolSystemPrompt,
  EVENT_ASSISTANT_TOOL_USER_MANDATE
} from './buildEventAssistantToolSystemPrompt.js'

export enum QuestionClassification {
  ON_TOPIC_ANSWER = 'ON_TOPIC_ANSWER',
  ON_TOPIC_ASK_SPEAKER = 'ON_TOPIC_ASK_SPEAKER',
  UNANSWERABLE = 'UNANSWERABLE',
  OFF_TOPIC = 'OFF_TOPIC',
  CATCHUP = 'CATCHUP'
}

export function buildLLMTemplates(personalityName?: string | null, botName?: string, toolNames: string[] = []) {
  const personalityContent = personalityName ? personalitySection : ''
  const botIdentity = botName
    ? `Your name is ${botName} - always refer to yourself with this exact spelling, even if your name appears differently in transcripts or conversation history.`
    : ''
  const hasTools = toolNames.length > 0

  const resourceSection = hasTools
    ? `When information isn't in the context:
- Use your available tools (e.g. web_search) to find the answer before responding.
- If tools return no results, provide what you know from general knowledge.`
    : `When information isn't in the context:
- Provide what you know from general knowledge.
- Suggest specific resources or places to find more information (e.g., Bureau of Labor Statistics, industry reports, relevant organizations).`

  const helpfulnessLine = hasTools
    ? `Always aim to be helpful - use your tools to find information the event materials lack, then provide a substantive response.`
    : `Always aim to be helpful - provide the information you can and point toward additional resources.`

  /*
   * Classification prompt sections: tool-aware vs tool-less.
   *
   * Without tools the agent has limited ability to resolve factual questions,
   * so the prompt biases toward ON_TOPIC_ASK_SPEAKER (route to moderator).
   *
   * With tools (web_search) the agent can draw on context + general knowledge
   * + web search, so the bias flips to ON_TOPIC_ANSWER. ON_TOPIC_ASK_SPEAKER
   * is reserved for questions that genuinely need the speaker's personal
   * opinion, lived experience, or non-public specialized expertise.
   *
   * These strings are interpolated into the semanticClassificationSystem
   * template below. The rest of the classification prompt (OFF_TOPIC,
   * CATCHUP, UNANSWERABLE, output format) is shared between both variants.
   */
  const classificationDefaultBias = hasTools
    ? `**Default assumption:** The assistant can answer most on-topic questions using event context, its own knowledge base, and web search (ON_TOPIC_ANSWER). Reserve ON_TOPIC_ASK_SPEAKER **only** for questions that genuinely require the speaker's personal opinion, subjective interpretation, lived experience, or unique non-public expertise.
Important! When deciding between ON_TOPIC_ASK_SPEAKER and ON_TOPIC_ANSWER, bias towards ON_TOPIC_ANSWER. The assistant has access to event context, broad general knowledge, and web search - if the question is factual, definitional, comparative, explanatory, or seeks any information that exists in the public domain or the assistant's knowledge, classify as ON_TOPIC_ANSWER.`
    : `**Default assumption: Almost all questions about the event topic should go to the speaker (ON_TOPIC_ASK_SPEAKER)**`

  const classificationAskSpeaker = hasTools
    ? `**ON_TOPIC_ASK_SPEAKER**: Question requires the speaker's PERSONAL input or SPECIALIZED EXPERTISE that is unlikely to be available through public sources. Also: audience sentiment/feedback the speaker would benefit from seeing.
- The speaker's personal opinions, predictions, or subjective takes
- Requests for the speaker's personal experience or decisions ("why did you choose X?")
- Questions seeking specialized, insider, or cutting-edge knowledge where the speaker likely has significantly deeper insight than publicly available sources (e.g., unpublished data, real-world practitioner experience with edge cases, niche implementation details from their own work)
- User feedback, criticism, or reactions about the talk (e.g. "boring", "disagree", "interesting")
- Questions about what the speaker will cover next or their future plans
- However: if the question is about well-established concepts, commonly documented practices, or readily searchable facts - even within the speaker's domain - do NOT use this, use ON_TOPIC_ANSWER
- If the answer is factual, definitional, or generally knowable (even without web search, e.g. "What is machine learning?"), do NOT use this - use ON_TOPIC_ANSWER
- If the answer could be found via web search (stats, news, comparisons, resource lists), do NOT use this - use ON_TOPIC_ANSWER`
    : `**ON_TOPIC_ASK_SPEAKER**: Question relates to the event topic (DEFAULT for topic-related questions), OR helpful for the speaker to understand audience positive or negative sentiment.
Important! When deciding between ON_TOPIC_ASK_SPEAKER and ON_TOPIC_ANSWER, bias towards ON_TOPIC_ASK_SPEAKER.
Exception: if the question requests direct, specific factual info or statistics within the event topic's domain (including adjacent subtopics like updated time windows or comparable providers/policies), bias towards ON_TOPIC_ANSWER.
- Precedence: If the user asks for direct factual statistics/policy/guardrail details (and is implicitly requesting verifiable published sources), classify as ON_TOPIC_ANSWER, even if you also consider speaker-focused categories.
- Speaker's opinions, perspectives, or expertise on anything related to the topic
- Requests for the speaker's interpretation/perspective of data/stats about the event topic (not just the raw facts)
- Requests for resources, recommendations, or next steps (except when the user requests citations/sources to support direct facts within the topic's domain)
- User feedback, criticism, or reactions about the talk (e.g. "boring", "disagree", "interesting")
- Personal questions about the speaker's views or preferences related to the topic
- If it's about the event topic and NOT one of the categories below, use this
- Do not classify as this if it's a simple acknowledgment ("thanks", "got it")`

  const classificationOnTopicAnswer = hasTools
    ? `**ON_TOPIC_ANSWER**: Can be answered WITHOUT the speaker's personal input (DEFAULT for on-topic questions). The assistant can draw on event context, its general knowledge base, AND web search.
- Any factual, definitional, or explanatory question about the event topic or adjacent subjects (e.g. "What is X?", "How does Y work?", "What are the differences between A and B?")
- Questions answerable from general knowledge alone (e.g. well-known concepts, established science, common frameworks)
- Any researchable question (stats, news, comparisons, current state of things, resource lists)
- Help writing/formulating a question for the speaker
- Speaker/moderator info available in context (name, bio)
- Direct quotes or summaries of what was explicitly said
- Content creation based on the event (tweets, summaries, posts, etc.)
- Simple acknowledgments ("thanks", "got it")
- Requests for resources, recommendations, or "where can I learn more about X?"
- Requests for up-to-date facts/stats or policy/guardrail details in the topic's domain`
    : `**ON_TOPIC_ANSWER**: Can be answered authoritatively and exhaustively WITHOUT speaker input from available context and clearly NOT helpful for the speaker to understand audience sentiment.
- Help writing/formulating a question for the speaker
- Speaker/moderator info available in context (name, bio)
- Direct quotes or summaries of what was explicitly said
- Content creation based on the event (tweets, summaries, posts, etc.)
- Simple acknowledgments ("thanks", "got it")
- Direct requests for up-to-date facts/stats or policy/guardrail details in the topic's domain (e.g., "last month" numbers, or comparable provider guardrails when the event discusses a different provider)`

  return {
    timeWindowSystem: `${
      botIdentity ? `${botIdentity} ` : ''
    }You are rephrasing short transcript chunks from a live event. The user missed this part of the conversation and only needs the reworded content.

${personalityContent}

**CRITICAL RULES:**
- Use only the provided transcript chunks.
- Do not add context or thematic commentary
- Use only "they/them" pronouns when referring to any person, including speakers, attendees, or individuals mentioned in questions, regardless of how the user refers to them.
- State what was said directly - avoid "the speaker discussed..." or similar.

**Output Style:**
- 1-3 sentences maximum.
- Natural, clear English.
- Contain only the essential rephrased content, nothing extra.
`,
    semanticSystem: `${botIdentity ? `${botIdentity} ` : ''}You answer questions about a live event.

${personalityContent}

Answer the question using these rules:

**CRITICAL RULES:**
- Prioritize information from the retrieved context when available.
- **When speaker names, moderator names, or people are mentioned:** Check the retrieved context for official speaker/moderator names and bios. Transcription may contain name errors, so use the official names from the context when available. If a user asks about "John Smith" but the context shows the speaker is "Jon Smythe," use the correct spelling from the retrieved data. If the context shows a name followed by "(also known as ...)", treat both as the same person and always output the canonical name - the alternate name is an intentional identity hint, not a nickname preference. Never use the alternate name in your response in any form - not standalone, not in parentheses, not as an abbreviation - even if the user used it in their question.
- **When referring to speakers or moderators:** Use their official names and credentials from the retrieved context. If bio information is available, you may reference relevant expertise when it adds value to your response.
- If the context doesn't contain the answer, use your general knowledge to provide a helpful response.
- When using general knowledge, be clear about your sources (e.g., "According to general industry data..." or "Research typically shows...")
- Use only "they/them" pronouns when referring to any person, including speakers, attendees, or individuals mentioned in questions, regardless of how the user refers to them.
- Do not invent specific details about the event itself.
- **For catchup requests:** Provide a brief summary of key points covered based on available context. If context is limited, acknowledge this and suggest they review available materials or ask specific questions about topics of interest.
- **For feedback, criticism, or reactions** (e.g., "this is stupid", "boring", "I disagree"): Acknowledge their perspective briefly and supportively without being defensive. Examples: "I understand this perspective may not resonate with everyone" or "That's valuable feedback for the speaker."

${resourceSection}
- If appropriate, suggest they ask the speaker for event-specific insights.
- **For questions about speakers/moderators without available bio data:** Acknowledge you don't have their background information in the current context, but focus on what they've discussed in the event if relevant.

**Failsafe:** If you cannot provide any substantive answer, explain why.

Output Style:
- 1-3 sentences maximum.
- Direct and clear; no pleasantries, filler, or meta-commentary.
- ${helpfulnessLine}
- Always provide a substantive response.
`,
    semanticClassificationSystem: `You are a classification system for live event Q&A. Return ONLY a classification string.

**IMPORTANT -- Context-reference check (apply before choosing OFF_TOPIC):**
Before you classify any question as OFF_TOPIC, verify whether the question mentions or refers to any entity, person, product, organization, concept, statistic, or fact that appears in the **Context** (Recent Transcript, Relevant Retrieved Context), the **Event topic**, or the **Recent conversation**. If it does, and the question could conceivably add to or extend the ongoing discussion, it is **not OFF_TOPIC** -- classify as ON_TOPIC_ANSWER (if answerable from context/general knowledge) or ON_TOPIC_ASK_SPEAKER (if the speaker's input would help).
Treat **Recent conversation** as part of the ongoing discussion: if prior messages show participants building a concrete sub-thread (logistics, food, scheduling, coordination tied to experiencing this event together) and the current question continues that same thread, it extends the live-event experience - do **not** use OFF_TOPIC even when the headline session topic alone would not suggest that subject.
**Worked example:** The formal talk may be about one subject (e.g. a science topic on stage), while **Recent conversation** shows attendees coordinating something practical for the same gathering (potluck, what to bring, dishes). A follow-up that continues that coordination (e.g. asking for a recipe to bring) is **not OFF_TOPIC** - classify as ON_TOPIC_ASK_SPEAKER (or ON_TOPIC_ANSWER if fully answerable without the speaker).

${classificationDefaultBias}

**Classifications:**

**CATCHUP**: General event summary requests
- Contains phrases like: "what did I miss", "catch me up", "what happened so far", "summarize"
- Asks for broad overview, not specific opinions

${classificationAskSpeaker}

${classificationOnTopicAnswer}

**OFF_TOPIC**: Zero connection to the event or the event topic, or an entirely irrelevant request or instruction
- Must be completely unrelated subject matter
- **Ignore @BotName mentions:** The user question may start with an @mention to the assistant (e.g. "@Berkie! ..."). Strip that prefix mentally - it is not part of the topic signal.
- **Context anchoring:** If the question asks for names, lists, counts, entities, products, or facts that **appear in the Context** (Recent Transcript or Relevant Retrieved Context) or are clearly the same subject as phrases in that Context (e.g. "15 AI companions" when the transcript discusses those companions), it is **not OFF_TOPIC**. Prefer ON_TOPIC_ANSWER when the answer is likely in the Context; otherwise ON_TOPIC_ASK_SPEAKER.
- **Conversation-thread continuation:** You receive prior chat messages before the current user message. If recent turns show participants and/or the speaker actively discussing a concrete sub-topic, treat follow-up questions that **continue that same thread** as **on-topic** (usually ON_TOPIC_ASK_SPEAKER, or ON_TOPIC_ANSWER if fully answerable from transcript/context alone). Do **not** use OFF_TOPIC for those follow-ups, even if they would look unrelated to the overall session title **without** that thread context.
- Still use OFF_TOPIC for random personal errands, spam, or topics with **no** clear link to what the group is discussing in those recent turns.
- Do NOT use OFF_TOPIC for adjacent subtopics within the same domain/theme. Adjacent includes: the same metric/time window but newer (e.g. "last month"), comparable organizations/providers in the same category (e.g. asking about a different provider's guardrails while the event discusses another), and directly related safety/guardrails policies or regulations.
- Example for aliens event: "What's the weather?" = OFF_TOPIC
- Example for aliens event: "How many sightings per year?" = ON_TOPIC_ANSWER
- Example for aliens event: "How many sightings last month?" = ON_TOPIC_ANSWER
- If it mentions the event/speaker/talk at all = NOT off-topic

**UNANSWERABLE**: Extremely rare - use only for truly unclear or impossible questions
- Completely unintelligible questions
- Requires unavailable proprietary data

**Output Format:**
**Return ONLY a single string - one of:** CATCHUP, ON_TOPIC_ASK_SPEAKER, ON_TOPIC_ANSWER, OFF_TOPIC, UNANSWERABLE
Do NOT provide any explanation or additional text.

**Reminder:** Always read **Recent conversation** (in the user message) together with **Event topic** and **Context** before choosing OFF_TOPIC.`,
    offTopicSystem: `You are an AI assistant for a live event. The user has asked something unrelated to the event topic.

${personalityContent}

**Your task:** Politely redirect the user back to the event topic. Let them know you're here to help with event-related questions.

**Output Style:**
- 1-2 sentences maximum.
- Friendly but brief.
- Mention that you're best at event-related questions.

- Do not attempt to answer the off-topic question, even partially.
- Do not explain why the question is off-topic in a judgmental way.
- Do not suggest the user go elsewhere for the answer (e.g., "try Google").
- Mention the event topic or the general subject area if it is clear from the context.
- Don't end with questions like "What can I help you with?"
`,
    unanswerableSystem: `You are an AI assistant for a live event. You cannot provide a good answer to the user's question.

${personalityContent}

**Your task:** Let the user know you don't have a great answer and suggest they rephrase or try a different question. Mention you're best at event-related questions.

**Output Style:**
- 1-2 sentences maximum.
- Friendly but brief.
- Encourage them to try rephrasing.
- Don't end with questions like "What can I help you with?"
`,
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
  offTopicSystem: [],
  unanswerableSystem: [],
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

async function getResponse(question, context, chatHistory, topic, systemTemplate) {
  const llm = await this.getLLM()
  return getChatPromptResponse(llm, systemTemplate, this.llmTemplates.user, { context, question, topic }, chatHistory)
}

async function shouldGenerateVisual(question, classification, llmResponse, templates) {
  // Auto-reject certain classifications
  if (classification === QuestionClassification.OFF_TOPIC || classification === QuestionClassification.UNANSWERABLE) {
    logger.debug('Skipping visual generation: question is off-topic or unanswerable')
    return false
  }

  // Auto-reject simple/short responses (acknowledgments, etc.)
  if (llmResponse.length < 50) {
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

/*
 * Always-present the names list so the LLM has correct names in context,
 * even when RAG retrieval doesn't surface the speaker metadata
 * (e.g. for generic questions like "what is this event about?").
 */
export function compileSpeakerNames(conversation): string {
  const lines: string[] = []

  conversation.presenters?.forEach((presenter) => {
    if (!presenter.name) return
    const altText = presenter.alternateName ? ` (also known as "${presenter.alternateName}")` : ''
    lines.push(`- ${presenter.name}${altText} - Speaker.`)
  })

  conversation.moderators?.forEach((moderator) => {
    if (!moderator.name) return
    const altText = moderator.alternateName ? ` (also known as "${moderator.alternateName}")` : ''
    lines.push(`- ${moderator.name}${altText} - Moderator.`)
  })

  if (lines.length === 0) return ''
  return `## Event Participants:\n${lines.join('\n')}\n\n`
}

export async function answerQuestion(userMessage, conversationHistory, options?) {
  const chatHistory = userMessage?.channels?.includes('chat')
    ? formatMultiUserConversationHistory(conversationHistory, this)
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

  // Resolve tools from the agent's configured tool list (if any)
  const configuredToolNames: string[] = this.agentConfig?.tools || []
  const tools = configuredToolNames.length > 0 ? getTools(configuredToolNames) : []

  // Get the appropriate templates based on personality setting
  const templates = buildLLMTemplates(personalityName, this.agentConfig?.botName, configuredToolNames)

  // Use provided context from options if available, otherwise search transcript
  let contextString: string
  let promptType = options?.promptType // 'timeWindow' or 'semantic'

  if (options?.context) {
    // Use provided context string directly
    contextString = options.context
  } else {
    // Normal flow - search transcript
    const searchResult = await transcript.searchTranscript(this, question, this.conversationHistorySettings?.endTime)
    const { chunks, timeWindow } = searchResult

    // Determine prompt type from search result if not provided
    if (!promptType) {
      promptType = timeWindow ? 'timeWindow' : 'semantic'
    }

    if (timeWindow) {
      // For time window searches, use only the chunks
      contextString = chunks
    } else {
      // For semantic searches, always include provided names so the LLM has
      // canonical speaker/moderator names even when RAG doesn't retrieve their metadata docs
      const participantNamesContext = compileSpeakerNames(this.conversation)
      const liveTranscript = transcript.getTranscript(this, 300, this.conversationHistorySettings?.endTime)

      const hasBackground = this.conversation.resources?.some((r) => r.source === 'speaker')
      let backgroundChunks = ''
      if (hasBackground) {
        try {
          const backgroundResult = await rag.getContextChunksForQuestion(
            `background-${this.conversation._id}`,
            question,
            (doc, idx) => `Source ID: ${idx}\nArticle title: ${doc.metadata.citation}\nArticle Snippet: ${doc.pageContent}`
          )
          backgroundChunks = backgroundResult.chunks
        } catch (err) {
          logger.warn(
            `eventQuestionHandler: failed to query background collection for conversation ${this.conversation._id}: ${err}`
          )
        }
      }

      contextString = [
        participantNamesContext.trimEnd(), // ## Event Participants
        `## Recent Transcript:\n${liveTranscript}`,
        `## Relevant Retrieved Context:\n${chunks}`,
        backgroundChunks
          ? `## Background Reading:\n(When using information from this section, cite the source by name in your response.)\n${backgroundChunks}`
          : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  }

  // Default to semantic if no prompt type specified
  const isTimeWindow = promptType === 'timeWindow'

  // Skip visual generation if question is skipped because off-topic or unanswerable
  let allowGenerateVisual = true

  const topic = options?.topic || this.conversation.name

  let systemTemplate: string
  let templateType: 'offTopic' | 'unanswerable' | 'timeWindow' | 'semantic'
  let classification: QuestionClassification

  if (isTimeWindow) {
    systemTemplate = templates.timeWindowSystem
    templateType = 'timeWindow'
    classification = QuestionClassification.CATCHUP
  } else {
    const rawClassification = await getResponse.call(
      this,
      question,
      contextString,
      chatHistory,
      topic,
      templates.semanticClassificationSystem
    )
    const validClassifications = new Set(Object.values(QuestionClassification))
    classification = validClassifications.has(rawClassification as QuestionClassification)
      ? (rawClassification as QuestionClassification)
      : QuestionClassification.UNANSWERABLE
    if (rawClassification !== classification) {
      logger.warn(`Unexpected classification response: "${rawClassification}", defaulting to UNANSWERABLE`)
    }
    if (classification === QuestionClassification.OFF_TOPIC) {
      logger.debug('Question classified as off-topic')
      systemTemplate = templates.offTopicSystem
      templateType = 'offTopic'
      allowGenerateVisual = false
    } else if (classification === QuestionClassification.UNANSWERABLE) {
      logger.debug('Question classified as unanswerable')
      systemTemplate = templates.unanswerableSystem
      templateType = 'unanswerable'
      allowGenerateVisual = false
    } else {
      systemTemplate = templates.semanticSystem
      templateType = 'semantic'
    }
  }

  let llmResponse: string
  if (tools.length > 0) {
    logger.debug(`Responding with tools enabled: [${configuredToolNames.join(', ')}], systemTemplate: ${templateType}`)
    const llm = await this.getLLM()
    const toolSystemPrompt = buildEventAssistantToolSystemPrompt(systemTemplate, topic, contextString)
    const userPrompt = `${EVENT_ASSISTANT_TOOL_USER_MANDATE}## User question:\n${question}`
    const agentBundle = (await getAgentStructuredResponse(
      llm,
      tools,
      toolSystemPrompt,
      userPrompt,
      undefined,
      chatHistory,
      10,
      { returnToolTrace: true }
    )) as { text: string; toolTrace: { invoked: boolean; calls: Array<{ name: string; args: unknown }> } }
    llmResponse = agentBundle.text
    const toolCalls = agentBundle.toolTrace.calls.length
    logger.info(
      `eventAssistant.toolPath toolsEnabled=true toolCalls=${toolCalls} toolNames=[${configuredToolNames.join(
        ', '
      )}] systemTemplate=${templateType}`
    )
    if (configuredToolNames.includes('web_search') && toolCalls === 0) {
      logger.warn(
        `eventAssistant.toolPath web_search configured but toolCalls=0 systemTemplate=${templateType} - model may have skipped search`
      )
    }
    const tracePayload = JSON.stringify({
      invoked: agentBundle.toolTrace.invoked,
      calls: agentBundle.toolTrace.calls.map((c) => ({ name: c.name, args: c.args }))
    })
    logger.debug(
      tracePayload.length > 8000
        ? `eventAssistant.toolTrace ${tracePayload.slice(0, 8000)}...`
        : `eventAssistant.toolTrace ${tracePayload}`
    )
  } else {
    llmResponse = await getResponse.call(this, question, contextString, chatHistory, topic, systemTemplate)
  }

  const responseChannels = this.conversation.channels.filter((channel: IChannel) =>
    userMessage.channels.includes(channel.name)
  )

  let responseMessage = llmResponse
  let imageGenResponse
  let parentMessageId

  // Set parent for threading
  if (userMessage?.channels?.includes('chat')) {
    // For chat: thread under the original message or current message
    parentMessageId = userMessage.parentMessage || userMessage._id
  } else if (userMessage.parentMessage) {
    // For DMs: only set parent if the incoming message is already a reply (user initiated side convo)
    parentMessageId = userMessage.parentMessage
  }

  // Check if visual generation should happen (either forced via /visual or user preference)
  const forceVisual = options?.forceVisual === true

  // Only use visual preference on a user's private channel, not e.g. group chat
  const isDirectChannel = responseChannels.some((channel: IChannel) => channel.direct)

  if (!allowGenerateVisual) logger.debug('Visual generation skipped due to off-topic or unanswerable question')

  if ((forceVisual || isDirectChannel) && allowGenerateVisual) {
    let shouldGenerate = false

    if (forceVisual) {
      logger.debug('Visual generation forced via /visual command')
      // For /visual command, always generate
      // User explicitly requested visual, so respect their intent
      shouldGenerate = true
    } else {
      // isDirectChannel - only now do we need the user's preferences
      const user = await User.findById(userMessage.owner)
      if (user?.preferences?.visualResponse) {
        logger.debug(`User ${user._id} has visual response preference enabled`)
        // Classify if this question/answer would benefit from a visual
        shouldGenerate = await shouldGenerateVisual.call(this, question, classification, llmResponse, templates)
      }
    }

    if (shouldGenerate) {
      logger.debug(`Creating separate image-gen message${forceVisual ? ' (forced)' : ''}`)
      const imageGenChannel = this.conversation.channels.find((channel: IChannel) => channel.name === 'image-gen')
      if (imageGenChannel) {
        // Add visual generation indicator to the user-facing message
        responseMessage = `${llmResponse}\n\n\n\n**\uD83C\uDFA8 Generating visual...**`

        // Create separate response for image-gen with structured Q&A body
        imageGenResponse = {
          visible: false, // hidden from users, just for processing
          message: {
            sourceMessage: userMessage._id.toString(),
            answer: llmResponse,
            responseChannels: userMessage.channels,
            parent: userMessage.parentMessage?.toString()
          },
          messageType: 'json',
          channels: [imageGenChannel]
        }
      } else {
        logger.warn('image-gen channel not found on conversation')
      }
    }
  }

  const agentResponse = {
    visible: true,
    message: {
      text: responseMessage,
      type: classification.toLowerCase()
    },
    messageType: 'json',
    channels: responseChannels,
    context: contextString,
    classification,
    promptType,
    topic,
    parent: parentMessageId
  }

  return imageGenResponse ? [agentResponse, imageGenResponse] : [agentResponse]
}
