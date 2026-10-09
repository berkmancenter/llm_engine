import { z } from 'zod'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IChannel, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatTranscript, formatSingleUserConversationHistory } from '../helpers/llmInputFormatters.js'

export type JargonTerm = {
  term: string // short label only, e.g. "SLO" — not a sentence
  text: string // plain-language explanation of this term only
  sourceText?: string // verbatim transcript quote for this specific term, when one exists
}

export type JargonFilterResponse = {
  type: 'jargon_clarification'
  terms: JargonTerm[] // one entry per distinct jargon term explained in this response
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
- Anything you are not confident was spoken clearly and legibly — if a stretch of transcript is garbled, mumbled, or ambiguous, skip it rather than guessing what the term might have been. Only clarify terms that were actually said; never invent or infer a term/label for a concept that was merely discussed around without being named outright

**How to write each clarification:**
- Cover all jargon found in the window — return one entry per distinct term, each with its own explanation
- Explain each term as if to a high school student with no background in the field — use everyday analogies and avoid assuming any prior knowledge
- Be extremely concise: one sentence, two at the absolute most — not two long or compound sentences
- Do not repeat a term in its own explanation without immediately defining it
- Never imply a term is obvious or easy, or that the reader should already know it
- Avoid phrases like "simply", "just", "basically", "obviously", or "of course"
- For each term's sourceText, use a short verbatim snippet from the transcript — about 5-6 words centered on the term, framed with "..." on both sides (e.g. "...we track our SLOs closely..."), never a full sentence
- Since a term is only ever flagged when it was clearly spoken, a quotable snippet should almost always be available — only omit sourceText when cross-talk or transcript formatting makes it genuinely impossible to extract a clean, contiguous short quote, never because you're unsure what the term was (in that case, don't flag the term at all). Don't omit it just because trimming to a short quote takes more effort, and never fabricate one or reuse another term's quote

## Output Format

Return a JSON object with the following fields:

{{
  "jargonFound": boolean,
  "terms": "Array of jargon term objects found in this window, or [] if jargonFound is false. Each object has: \\"term\\" (short label only, e.g. \\"SLO\\" — not a sentence), \\"text\\" (plain-language explanation of this term only — one sentence, two at most), and optionally \\"sourceText\\" (a short, ~5-6 word verbatim transcript snippet for this specific term, framed with \\"...\\" on both sides — omit the field entirely, do not use null, in the rare case no clean quote exists)."
}}

Example terms value:
[
  { "term": "SLO", "text": "A target for how reliable a system should be.", "sourceText": "...we track our SLOs closely..." },
  { "term": "MTTR", "text": "How long it takes to fix something after it breaks." }
]

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const jargonTermSchema = z.object({
  term: z.string(),
  text: z.string(),
  sourceText: z.string().nullable().optional()
})

const jargonFilterSchema = z.object({
  jargonFound: z.boolean(),
  terms: z.array(jargonTermSchema).nullable()
})

const USER_TEMPLATE = `## Event Topic:
{topic}

{seenTerms}

## Transcript:
{transcript}

Analyze the transcript above for technical jargon and return JSON only.`

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
  text: z.string().nullable()
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
    // Return early if no messages in the conversation history window
    if (!conversationHistory.messages || conversationHistory.messages.length === 0) {
      return []
    }

    const transcript = formatTranscript(conversationHistory.messages)

    // Collect terms already explained in prior invocations from saved jargon messages.
    // Historical messages may still carry the old flat `terms: string[]` shape (never
    // backfilled), so each entry is normalized to its term name regardless of shape.
    const priorMessages = (this.conversation.messages ?? []) as Array<{ fromAgent: boolean; body: unknown }>
    const alreadyExplained: string[] = priorMessages
      .filter((m) => m.fromAgent && (m.body as JargonFilterResponse)?.type === 'jargon_clarification')
      .flatMap((m) => {
        const { terms } = m.body as { terms?: unknown }
        if (!Array.isArray(terms)) return []
        return terms.map((t) => (typeof t === 'string' ? t : (t as JargonTerm).term))
      })

    const seenTermsCheck =
      alreadyExplained.length > 0
        ? `## Already Explained Terms:\nThe following terms have already been clarified earlier in this event. Do not explain them again:\n${alreadyExplained
            .map((t) => `- ${t}`)
            .join('\n')}`
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

    // Unlike the old shared text/sourceText fields, there's nothing left to post once terms
    // is missing or empty — skip rather than sending an empty message.
    if (!Array.isArray(response.terms) || response.terms.length === 0) {
      logger.warn(`${this.name}: jargonFound was true but terms array was empty or invalid — skipping`)
      return []
    }

    // Post to the shared jargon channel rather than fanning out across opted-in users' own
    // DM channels — jargonClarification is a global per-user preference that now only decides
    // whether a viewer's own client surfaces this channel, not whether the agent posts here.
    const jargonChannel = this.conversation.channels.find((c: IChannel) => c.name === 'jargon')
    if (!jargonChannel) return []

    logger.info(`${this.name}: jargon detected, posting to the jargon channel`)

    // Omit sourceText entirely (rather than sending null) when the LLM didn't provide one,
    // per-term — the frontend treats an omitted field differently from an explicit null.
    const terms: JargonTerm[] = response.terms.map((t) => ({
      term: t.term,
      text: t.text,
      ...(t.sourceText ? { sourceText: t.sourceText } : {})
    }))

    const message: JargonFilterResponse = {
      type: 'jargon_clarification',
      terms,
      transcriptWindow: {
        start: conversationHistory.start.getTime(),
        end: conversationHistory.end.getTime()
      }
    }

    return [
      {
        visible: true,
        message,
        messageType: 'json',
        channels: [jargonChannel]
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
