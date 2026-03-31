import { z } from 'zod'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IChannel, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatTranscript, formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'
import User from '../../models/user.model/user.model.js'

export type JargonFilterResponse = {
  type: 'jargon_clarification'
  text: string // the clarified text
  sourceText: string // original transcript excerpt
  terms: string[] // flat list of jargon term names explained in this response
  transcriptWindow: {
    // Unix start and end times for the transcript window
    start: number
    end: number
  }
}

export const JARGON_FILTER_SYSTEM_PROMPT = `You are an assistant monitoring a live event transcript for technical jargon. Your job is to help participants who are not subject matter experts follow along.

## Rules

**What counts as jargon:**
- Acronyms or abbreviations a general audience would not know (e.g. "SLO", "MTTR", "LTV")
- Domain-specific terms or phrases unlikely to be understood outside the field
- Concepts presented without explanation that require prior expertise to understand

**What does NOT count as jargon:**
- Common words used in a technical context (e.g. "framework", "model", "process")
- Terms that were already explained earlier in the transcript
- Proper nouns (names of people, companies, products)

**How to write the clarification:**
- Cover all jargon found in the window in a single, consolidated response
- Begin with a plain-language summary of what was just discussed in the transcript. Label it "**Summary:**" on its own line. Write it in first person as if you are the speaker (e.g. "This is an explanation of how our system handles issues") — never start with "The speaker said" or refer to the speaker in third person. Maximum two sentences — do not exceed this limit.
- After the summary, write each jargon term as its own bullet point on a new line
- Bold the jargon term or phrase at the start of each bullet (e.g. **SLO** — ...)
- Explain each term as if to a high school student with no background in the field — use everyday analogies and avoid assuming any prior knowledge
- Be concise: one or two sentences per term is enough
- Do not repeat jargon terms in the clarification without immediately defining them
- Never imply the terms are obvious or easy, or that the reader should already know them
- Avoid phrases like "simply", "just", "basically", "obviously", or "of course"

## Output Format

Return a JSON object with the following fields:

{{
  "jargonFound": boolean,
  "text": "A plain-language summary followed by a bullet-point list clarifying each jargon term found (null if jargonFound is false). The summary must be labeled '**Summary:**' and separated from the bullets by \\n\\n. Each bullet must be on its own line separated by \\n. Example: **Summary:**\\n\\nThis is a discussion of how we set reliability targets and recover from outages.\\n\\n- **SLO** — A target for how reliable a system should be.\\n- **MTTR** — How long it takes to fix something after it breaks.",
  "sourceText": "Verbatim quote from the transcript that contains the jargon (null if jargonFound is false)",
  "terms": "Flat array of jargon term names explained in this response, matching exactly the bolded terms in the text field (null if jargonFound is false). Example: [\\"SLO\\", \\"MTTR\\"]"
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const jargonFilterSchema = z.object({
  jargonFound: z.boolean(),
  text: z.string().nullable(),
  sourceText: z.string().nullable(),
  terms: z.array(z.string()).nullable()
})

const USER_TEMPLATE = `## Event Topic:
{topic}

{seenTerms}

## Transcript:
{transcript}

Analyze the transcript above for technical jargon and return JSON only. The "text" field must begin with a "**Summary:**" section before the bullet points.`

// Interactive mode: Combined classification and answer
export const JARGON_FOLLOW_UP_SYSTEM_PROMPT = `You are a helpful assistant that answers follow-up questions about technical jargon and terminology from an event.

## Your Task

1. First, determine if the question is about jargon/terminology clarification
2. If YES: Answer the question about the jargon (include the "text" field in your response)
3. If NO: Do not include the "text" field in your response

## Questions that ARE about jargon:
- Technical terms, acronyms, or jargon from the event
- Definitions or explanations of concepts mentioned
- Further clarification about previously explained terms

## Questions that are NOT about jargon:
- General conversation or greetings
- Event logistics (time, location, etc.)
- Off-topic personal questions
- Questions unrelated to terminology or jargon

## Guidelines for answering (when isJargonRelated is true):
- Use plain language as if explaining to a high school student with no background in the field
- Be conversational and natural - this is a back-and-forth dialogue
- Keep responses concise (2-3 sentences unless more detail is needed)
- Use everyday analogies when helpful
- If the user asks for more detail about a term, expand on your previous explanation
- Never imply terms are obvious or that the reader should already know them
- Avoid phrases like "simply", "just", "basically", "obviously", or "of course"

Return JSON with:
- isJargonRelated: boolean (true if about jargon, false otherwise)
- text: string (your answer - ONLY include this field if isJargonRelated is true)

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const JARGON_FOLLOW_UP_USER_TEMPLATE = `## Event Topic:
{topic}

## User Question:
{userQuestion}

Determine if this is about jargon/terminology and answer if so. Return JSON only.`

const jargonFollowUpSchema = z.object({
  isJargonRelated: z.boolean(),
  text: z.string().optional()
})

export default verify({
  name: 'Jargon Filter Agent',
  description:
    'Periodically analyzes the transcript for technical jargon and sends plain-language clarifications to participants who have opted in',
  priority: 50,
  maxTokens: 2000,
  defaultTriggers: {
    periodic: { timerPeriod: 120, conversationHistorySettings: { channels: ['transcript'], timeWindow: 120 } },
    perMessage: { directMessages: true }
  },
  llmTemplateVars: {
    system: [],
    user: [
      { name: 'topic', description: 'The event topic' },
      { name: 'seenTerms', description: 'Already-explained terms to skip, or empty string if none' },
      { name: 'transcript', description: 'Transcript window to analyze for jargon' }
    ]
  },
  defaultLLMTemplates: {
    system: JARGON_FILTER_SYSTEM_PROMPT,
    user: USER_TEMPLATE
  },
  defaultLLMPlatform,
  defaultLLMModel,
  defaultLLMModelOptions: { maxTokens: 4000 },
  ragCollectionName: undefined, // earlier transcript context not needed, just analyzes the window

  async initialize() {
    return true
  },

  async evaluate(userMessage?: IMessage) {
    // Path A: Periodic trigger (no userMessage)
    if (!userMessage) {
      return {
        action: AgentMessageActions.CONTRIBUTE,
        userMessage,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    // Path B: Per-message trigger (direct channel message)
    // Only respond to threaded replies (not standalone DMs)
    if (!userMessage.parentMessage) {
      logger.info(`${this.name}: Ignoring non-threaded direct message`)
      return {
        userMessage,
        action: AgentMessageActions.OK,
        userContributionVisible: true,
        suggestion: undefined
      }
    }

    // Threaded reply detected - always contribute
    // (Off-topic detection happens in respond() to provide helpful decline message)
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory, userMessage?: IMessage) {
    const llm = await this.getLLM()
    if (!this.conversation) return []

    // Path B: Per-message trigger - interactive clarification
    if (userMessage) {
      const chatHistory = formatSingleUserConversationHistory(conversationHistory)

      const response = await getChatPromptResponse(
        llm,
        JARGON_FOLLOW_UP_SYSTEM_PROMPT,
        JARGON_FOLLOW_UP_USER_TEMPLATE,
        {
          topic: this.conversation.name,
          userQuestion: userMessage.body
        },
        chatHistory,
        jargonFollowUpSchema
      )

      const responseChannels = this.conversation.channels.filter((channel: IChannel) =>
        userMessage.channels?.includes(channel.name)
      )

      const parentMessageId = userMessage.parentMessage || userMessage._id

      // If off-topic, send polite decline
      if (!response.isJargonRelated || !response.text) {
        return [
          {
            visible: true,
            message: {
              text: 'I can only help clarify jargon from the event. Please ask event-related questions in the main chat.',
              type: 'jargon_follow_up'
            },
            messageType: 'json',
            channels: responseChannels,
            parent: parentMessageId
          }
        ]
      }

      // Send LLM-generated answer
      return [
        {
          visible: true,
          message: { text: response.text, type: 'jargon_follow_up' },
          messageType: 'json',
          channels: responseChannels,
          parent: parentMessageId
        }
      ]
    }

    // Path A: Periodic trigger - existing proactive jargon detection
    const transcript = formatTranscript(conversationHistory.messages)

    // Collect terms already explained in prior invocations from saved jargon messages
    const priorMessages = (this.conversation.messages ?? []) as Array<{ fromAgent: boolean; body: unknown }>
    const alreadyExplained: string[] = priorMessages
      .filter((m) => m.fromAgent && (m.body as JargonFilterResponse)?.type === 'jargon_clarification')
      .flatMap((m) => (m.body as JargonFilterResponse).terms ?? [])

    const seenTermsCheck =
      alreadyExplained.length > 0
        ? `## Already Explained Terms:\nThe following terms have already been clarified earlier in this event. Do not explain them again:\n${alreadyExplained.map((t) => `- ${t}`).join('\n')}`
        : ''

    const response = await getChatPromptResponse(
      llm,
      this.llmTemplates.system,
      this.llmTemplates.user,
      {
        topic: this.conversation.name,
        seenTerms: seenTermsCheck,
        transcript
      },
      [], // no chat history needed, only the transcript
      jargonFilterSchema
    )
    if (!response.jargonFound) return []

    if (!Array.isArray(response.terms) || response.terms.length === 0) {
      logger.warn(`${this.name}: jargon found but LLM returned invalid or empty terms array — skipping response`)
      return []
    }

    // Find direct channels where this agent is a participant and the user has opted in.
    const directChannels = this.conversation.channels.filter(
      (c: IChannel) => c.direct && c.participants?.some((p) => p._id?.toString() === this._id.toString())
    )
    const optedInChannels: IChannel[] = []

    for (const channel of directChannels) {
      for (const participant of channel.participants ?? []) {
        const user = await User.findById(participant._id)
        if (user?.preferences?.jargonClarification) {
          optedInChannels.push(channel)
          break
        }
      }
    }

    if (optedInChannels.length === 0) return []

    logger.info(`${this.name}: jargon detected, posting to ${optedInChannels.length} opted-in channel(s)`)

    const message: JargonFilterResponse = {
      type: 'jargon_clarification',
      text: response.text!,
      sourceText: response.sourceText!,
      terms: response.terms!,
      transcriptWindow: {
        start: conversationHistory.start.getTime(),
        end: conversationHistory.end.getTime()
      }
    }

    return [
      {
        visible: true, // message is sent to opted-in participant only
        message,
        messageType: 'json',
        channels: optedInChannels
      }
    ]
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
    return []
  }
})
