import { z } from 'zod'
import verify from '../helpers/verify.js'
import { AgentMessageActions, AgentResponse, ConversationHistory, IChannel } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import logger from '../../config/logger.js'

const SYSTEM_PROMPT = `You are a Moderator Assistant monitoring a live event. Your sole job is to detect moments when the human moderator should be alerted — not to intervene in the public chat yourself.

## What to escalate

Escalate when you detect any of the following:
- A cluster of private questions or concerns converging on a specific topic the moderator should address
- A significant theme or tension building that the speaker or facilitator is missing
- A question that many participants have but that hasn't been voiced publicly
- Strong emotional signals (frustration, confusion, excitement) that warrant a human facilitator response
- A moment where the conversation needs redirecting that only a human can do

## Privacy

- Never reference participants by name or pseudonym in any output — not in reasoning, not in the moderator message.
- Describe patterns in aggregate: "several participants," "a number of people," "a user said..." — never "Alice said..." or "@username."
- Abstract themes so no individual could recognize their own words being quoted.

## What NOT to escalate

- Minor tangents or passing comments
- Things already being handled visibly in the public chat
- Low-confidence patterns with only one or two signals
- Routine Q&A the speaker is already handling
- Patterns you have already escalated (see Previous Alerts) unless there are significant new signals or clear evolution

## Previous Alerts

You will be given a list of alerts you have already sent to the moderator, with their timestamps (UTC ISO 8601). Do not re-escalate the same pattern unless it has meaningfully grown — more participants signaling, significantly higher intensity, or a clear new dimension to the issue. Assume the moderator has seen and is handling any pattern you have already reported.

## Output format

Return a JSON object:
{{
  "shouldEscalate": boolean,
  "isNewPattern": boolean,
  "reasoning": "Internal analysis of what you see and why you are or are not escalating",
  "moderatorMessage": "Concise briefing for the moderator (null if not escalating). Include: what is happening, how many signals, and a suggested question or action.",
  "detectedPattern": "Brief description of the pattern (null if none)",
  "affectedUsers": number,
  "confidenceScore": 0-100
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`

const USER_TEMPLATE = `## Event Topic:
{topic}

## Previous Alerts Sent to Moderator (UTC timestamps):
{previousAlerts}

## Recent Transcript (last 10 minutes):
{recentTranscript}

## Retrieved Relevant Context from Transcript:
{retrievedChunks}

## Private Messages (Direct Messages):
{privateMessages}

## Shared Chat History:
{sharedChatHistory}

---

Assess whether the moderator should be alerted. Output valid JSON only.`

const MODERATOR_SCHEMA = z.object({
  shouldEscalate: z.boolean(),
  isNewPattern: z.boolean(),
  reasoning: z.string(),
  moderatorMessage: z.string().nullable().optional(),
  detectedPattern: z.string().nullable().optional(),
  affectedUsers: z.number().nullable().optional(),
  confidenceScore: z.number().min(0).max(100)
})

function getPreviousAlerts(messages, agentName) {
  const alerts = messages.filter(
    (msg) => msg.pseudonym === agentName && msg.fromAgent && msg.bodyType === 'json' && msg.body?.insights
  )

  if (alerts.length === 0) return 'None yet.'

  return alerts
    .map((msg) => {
      const ts = (msg.createdAt ?? new Date()).toISOString()
      const { insights } = msg.body as { insights: { value: string }[] }
      return insights.map((i) => `[${ts}] ${i.value}`).join('\n')
    })
    .join('\n')
}

export default verify({
  name: 'Moderator Notifier',
  description: 'Monitors private messages and the transcript to escalate significant themes to the moderator',
  priority: 80,
  maxTokens: 2000,
  defaultTriggers: {
    periodic: { timerPeriod: 120, conversationHistorySettings: { timeWindow: 120, channels: ['transcript'] } }
  },
  agentConfig: {},
  llmTemplateVars: {
    system: [],
    user: [
      { name: 'topic', description: 'The event topic' },
      { name: 'previousAlerts', description: 'Previously escalated alerts sent to the moderator this session' },
      { name: 'recentTranscript', description: 'Recent transcript (last 10 minutes)' },
      { name: 'retrievedChunks', description: 'Relevant retrieved context from RAG search' },
      { name: 'privateMessages', description: 'Private/direct messages from participants' },
      { name: 'sharedChatHistory', description: 'Shared chat history' }
    ]
  },
  defaultLLMTemplates: {
    system: SYSTEM_PROMPT,
    user: USER_TEMPLATE
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,
  useTranscriptRAGCollection: true,
  parseOutput: (msg) => {
    if (msg.bodyType === 'text') {
      return msg
    }

    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'

    // Handle moderator alerts (backChannelInsights format)
    if (msg.body.insights) {
      translatedMsg.body = `MODERATOR REPORT
${msg.body.insights.map((insight: { value: string }) => `* ${insight.value}`).join('\n')}`
      return translatedMsg
    }

    return translatedMsg
  },

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

  async respond(conversationHistory: ConversationHistory): Promise<AgentResponse<Record<string, unknown>>[]> {
    if (!this.conversation) {
      logger.warn(`${this.name}: No conversation available`)
      return []
    }

    const isModCommand = (msg) => msg.bodyType === 'json' && msg.body?.command === 'mod'

    const sharedChatHistory = getConversationHistory(this.conversation.messages, {
      count: 100,
      channels: ['chat'],
      endTime: conversationHistory.end
    })

    const privateHistory = getConversationHistory(
      this.conversation.messages,
      {
        count: 100,
        directMessages: true,
        endTime: conversationHistory.end
      },
      null,
      this.conversation.channels.filter((c: IChannel) => c.direct).map((c: IChannel) => c.name)
    )
    privateHistory.messages = privateHistory.messages.filter((msg) => !isModCommand(msg))

    const sharedChatMessages = formatMultiUserConversationHistory(sharedChatHistory)
    const privateMessages = formatMultiUserConversationHistory(privateHistory)

    const recentTranscript = transcript.getTranscript(this.conversation, 600, conversationHistory.end)
    const allMessages = [...sharedChatMessages, ...privateMessages].map((m) => m.content).join('\n')
    const { chunks } = await transcript.searchTranscript(this.conversation, allMessages, conversationHistory.end)

    const previousAlerts = getPreviousAlerts(this.conversation.messages, this.name)

    const llm = await this.getLLM()
    const analysis = (await getChatPromptResponse(
      llm,
      this.llmTemplates.system || SYSTEM_PROMPT,
      this.llmTemplates.user || USER_TEMPLATE,
      {
        topic: this.conversation.name,
        previousAlerts,
        recentTranscript,
        retrievedChunks: chunks,
        privateMessages: privateMessages.map((m) => m.content).join('\n') || 'No private messages.',
        sharedChatHistory: sharedChatMessages.map((m) => m.content).join('\n') || 'No shared chat messages yet.'
      },
      [],
      MODERATOR_SCHEMA
    )) as z.infer<typeof MODERATOR_SCHEMA>

    if (!analysis.shouldEscalate || analysis.confidenceScore < 60 || !analysis.moderatorMessage) {
      logger.debug(`${this.name}: No escalation needed. Reasoning: ${analysis.reasoning}`)
      return []
    }

    logger.info(`${this.name}: Escalating to moderator — ${analysis.detectedPattern} (new: ${analysis.isNewPattern})`)

    const moderatorAlert = {
      timestamp: {
        start: conversationHistory.start?.getTime() || Date.now(),
        end: conversationHistory.end?.getTime() || Date.now()
      },
      insights: [
        {
          value: analysis.moderatorMessage,
          type: 'insight'
        }
      ]
    }

    return [
      {
        visible: true,
        message: moderatorAlert,
        messageType: 'json',
        channels: this.conversation.channels.filter((c: IChannel) => c.name === 'moderator'),
        context: `Reasoning: ${analysis.reasoning}\nPattern: ${analysis.detectedPattern || 'N/A'}`
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
