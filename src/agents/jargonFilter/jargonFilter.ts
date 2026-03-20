import { z } from 'zod'
import verify from '../helpers/verify.js'
import { AgentMessageActions, ConversationHistory, IChannel } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import logger from '../../config/logger.js'
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

Analyze the transcript above for technical jargon and return JSON only. The "text" field must begin with a "**Summary:**" section before the bullet points.`

export default verify({
  name: 'Jargon Filter Agent',
  description:
    'Periodically analyzes the transcript for technical jargon and sends plain-language clarifications to participants who have opted in',
  priority: 50,
  maxTokens: 500,
  defaultTriggers: {
    periodic: { timerPeriod: 120, conversationHistorySettings: { channels: ['transcript'], timeWindow: 120 } }
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

    const transcript = formatTranscript(conversationHistory.messages)

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
