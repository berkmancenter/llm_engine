import { z } from 'zod'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IChannel } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import User from '../../models/user.model/user.model.js'

export type JargonFilterResponse = {
  type: 'jargon_clarification'
  text: string // the clarified text
  sourceText: string // original transcript excerpt
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
- Write in plain language — explain it the way you would to a knowledgeable colleague encountering this field for the first time
- Be concise: one sentence per term is enough
- Do not repeat jargon terms in the clarification without immediately defining them
- Never imply the terms are obvious or easy, or that the reader should already know them
- Avoid phrases like "simply", "just", "basically", "obviously", or "of course"

## Output Format

Return a JSON object with the following fields:

{{
  "jargonFound": boolean,
  "text": "A single plain-language clarification covering all jargon found (null if jargonFound is false)",
  "sourceText": "Verbatim quote from the transcript that contains the jargon (null if jargonFound is false)"
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const jargonFilterSchema = z.object({
  jargonFound: z.boolean(),
  text: z.string().nullable(),
  sourceText: z.string().nullable()
})

const USER_TEMPLATE = `## Event Topic:
{topic}

## Transcript:
{transcript}

Analyze the transcript above for technical jargon and return JSON only.`

export default verify({
  name: 'Jargon Filter Agent',
  description:
    'Periodically analyzes the transcript for technical jargon and sends plain-language clarifications to participants who have opted in',
  priority: 50,
  maxTokens: 500,
  defaultTriggers: {
    periodic: { timerPeriod: 90, conversationHistorySettings: { channels: ['transcript'] } }
  },
  agentConfig: {
    minInterval: 5 // 5 mins for now, can be adjusted if it's too long
  },
  llmTemplateVars: {
    system: [],
    user: [
      { name: 'topic', description: 'The event topic' },
      { name: 'transcript', description: 'Transcript window to analyze for jargon' }
    ]
  },
  defaultLLMTemplates: {
    system: JARGON_FILTER_SYSTEM_PROMPT,
    user: USER_TEMPLATE
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined, // earlier transcript context not needed, just analyzes the window

  async initialize() {
    return true
  },

  async evaluate(userMessage) {
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory) {
    const llm = await this.getLLM()
    if (!this.conversation) return []

    // Gets the messages for a given window
    const transcriptWindow = getConversationHistory(this.conversation.messages, {
      channels: ['transcript'],
      timeWindow: 300, // only get the last 5 minutes (300 seconds)
      endTime: conversationHistory.end
    })

    const transcript = formatTranscript(transcriptWindow.messages)

    const response = await getChatPromptResponse(
      llm,
      this.llmTemplates.system,
      this.llmTemplates.user,
      {
        topic: this.conversation.name,
        transcript
      },
      [], // no chat history needed, only the transcript
      jargonFilterSchema
    )
    if (!response.jargonFound) return []

    // Find direct channels where the participant has opted in to jargon clarification
    const directChannels = this.conversation.channels.filter((c: IChannel) => c.direct)
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
      transcriptWindow: {
        start: transcriptWindow.start.getTime(),
        end: transcriptWindow.end.getTime()
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
