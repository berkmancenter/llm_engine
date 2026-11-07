import { z } from 'zod'
import verify from '../helpers/verify.js'
import {
  AgentMessageActions,
  AgentResponse,
  ConversationEvent,
  ConversationHistory,
  IChannel,
  IMessage
} from '../../types/index.types.js'
import { QuestionResultSummary, QuestionResults } from './moderatorNotifier.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import { formatMultiUserConversationHistory, formatDmHistoryByChannel } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import logger from '../../config/logger.js'
import access from '../../auth/access.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import findWarmUpAnswers from '../helpers/warmUpAnswers.js'
import { findMessages } from '../../utils/messageVisibility.js'
import { GROUP_CHAT_CHANNELS } from '../helpers/groupChatChannel.js'

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
  "observation": "1–2 sentence factual summary of what is happening and how many participants are involved. No action items. Null if not escalating.",
  "recommendations": ["Short, specific suggested action for the moderator (maximum 2 items)"],
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
  observation: z.string().nullable().optional(),
  recommendations: z.array(z.string()).max(2).nullable().optional(),
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

const WARM_UP_THEMES_SCHEMA = z.object({
  themes: z.array(
    z.object({
      value: z.string().describe('A short description of one distinct theme or position in the warm-up answers'),
      matchingAnswers: z
        .array(z.number().int())
        .describe('The number of every answer below that aligns with this theme, from the numbered list given')
    })
  )
})

// Hard ceiling on how many buckets ever reach the moderator, Other included — capThemes enforces
// this regardless of whether the model honors the prompt's own request to stay near it.
const MAX_WARM_UP_THEMES = 5

const WARM_UP_THEMES_SYSTEM_PROMPT = `You are reviewing private warm-up question answers submitted by event
attendees before a live event started. Identify the distinct themes or positions across the answers, for
the moderator's own use — this is an internal moderator view, never shown to participants.

**CRITICAL RULES:**
- Each answer below is numbered. For every theme, list the number of every answer that aligns with it —
  do not describe, quote, or count answers yourself; reference them only by number. The count and examples
  shown to the moderator are derived entirely from the numbers you list, not from anything else you write.
- Ground every theme in the actual answers — never invent a theme no answer actually supports.
- Group answers expressing a similar view into one theme rather than listing every answer separately, but
  don't force answers that don't actually align into the same theme.
- Report at most ${MAX_WARM_UP_THEMES} themes. If the answers fall into more distinct groups than that,
  keep the most-supported ones and fold the rest into a final catch-all theme named "Other" — still list
  every one of its matching answer numbers, same as any other theme.
- Below that cap, a theme supported by just one answer is still worth reporting — the moderator should see
  the full range of responses, not just majority opinions.
- Use only "they/them" pronouns when referring to any person.
- Never use an em dash. Use a comma, period, or parentheses instead.

Return a JSON object: {{ "themes": [{{ "value": "...", "matchingAnswers": [1, 3] }}] }}`

const WARM_UP_THEMES_USER_TEMPLATE = `Numbered warm-up question answers:
{answers}`

/**
 * Backstop for MAX_WARM_UP_THEMES: the prompt already asks the model to fold overflow into its
 * own "Other" theme, but nothing guarantees compliance, so this enforces the cap regardless.
 * Keeps the most-supported themes and merges everything past the cap into one Other bucket,
 * combining counts and sampling a few examples from across the merged themes.
 */
function capThemes(results: QuestionResultSummary[]): QuestionResultSummary[] {
  if (results.length <= MAX_WARM_UP_THEMES) return results
  const sorted = [...results].sort((a, b) => b.count - a.count)
  const kept = sorted.slice(0, MAX_WARM_UP_THEMES - 1)
  const overflow = sorted.slice(MAX_WARM_UP_THEMES - 1)
  const other: QuestionResultSummary = {
    label: 'Other',
    count: overflow.reduce((sum, r) => sum + r.count, 0),
    examples: overflow.flatMap((r) => r.examples ?? []).slice(0, 3)
  }
  return [...kept, other]
}

async function buildWarmUpQuestionResultsForModerator(this): Promise<QuestionResults | null> {
  const promptMessages = await findMessages(this.conversation._id, 'model', { 'body.type': 'warmUpQuestion' })
  if (!promptMessages.length) return null
  const [promptMessage] = promptMessages

  // Pass the ids already fetched above so findWarmUpAnswers doesn't re-run the identical query.
  const answerMessages = await findWarmUpAnswers(
    this.conversation._id,
    promptMessages.map((m) => m._id)
  )
  if (!answerMessages.length) return null

  const question = extractMessageText(promptMessage)
  const format: 'text' | 'singleChoice' = promptMessage.prompt?.type === 'singleChoice' ? 'singleChoice' : 'text'

  if (format === 'singleChoice') {
    const options = promptMessage.prompt?.options ?? []
    const counts = new Map<string, number>(options.map((o) => [o.value, 0]))
    for (const answer of answerMessages) {
      const value = extractMessageText(answer)
      if (counts.has(value)) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    const results = options.map((o) => ({ label: o.label, count: counts.get(o.value) ?? 0 }))
    if (!results.some((r) => r.count > 0)) return null
    return { questionType: 'warmUpQuestion', question, format, results }
  }

  const answerTexts = answerMessages.map((m) => extractMessageText(m)).filter(Boolean)
  if (!answerTexts.length) return null
  const answersText = answerTexts.map((text, i) => `${i + 1}. ${text}`).join('\n')

  const llm = await this.getLLM()
  const themesResult = (await getChatPromptResponse(
    llm,
    WARM_UP_THEMES_SYSTEM_PROMPT,
    WARM_UP_THEMES_USER_TEMPLATE,
    { answers: answersText },
    undefined,
    WARM_UP_THEMES_SCHEMA
  )) as z.infer<typeof WARM_UP_THEMES_SCHEMA>

  // count/examples are derived from matchingAnswers, not trusted from the model directly — a
  // theme's text could otherwise claim more support than the answers it actually points at.
  const results = capThemes(
    (themesResult?.themes ?? [])
      .map((theme) => {
        const validIndices = [...new Set(theme.matchingAnswers)].filter((i) => i >= 1 && i <= answerTexts.length)
        return {
          label: theme.value,
          count: validIndices.length,
          examples: validIndices.slice(0, 3).map((i) => answerTexts[i - 1])
        }
      })
      .filter((result) => result.count > 0)
  )
  if (!results.length) return null

  return { questionType: 'warmUpQuestion', question, format, results }
}

export default verify({
  name: 'Moderator Notifier',
  description: 'Monitors private messages and the transcript to escalate significant themes to the moderator',
  priority: 80,
  maxTokens: 2000,
  defaultTriggers: {
    periodic: {
      timerPeriod: 120,
      proactive: true,
      conversationHistorySettings: { timeWindow: 120, channels: ['transcript'] }
    }
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

    if (msg.body.questionResults) {
      const { question, results } = msg.body.questionResults as QuestionResults
      translatedMsg.body = `MODERATOR REPORT: ${question}
${results.map((r) => `* ${r.label}: ${r.count}`).join('\n')}`
      return translatedMsg
    }

    return translatedMsg
  },

  async initialize() {
    return true
  },

  async evaluate(userMessage) {
    // The framework's own evaluate() (agent.model/index.ts) already skips this call
    // entirely when the conversation's total message count hasn't changed since last
    // activation — but that count includes messages from OTHER agents too, so it's
    // defeated by routine bot chatter even when no participant said anything. This
    // narrows the check to real participant activity within the agent's own tick period.
    const windowMs = ((this.triggers?.periodic?.timerPeriod ?? 120) as number) * 1000
    const cutoff = Date.now() - windowMs
    const hasRecentParticipantActivity = ((this.conversation.messages ?? []) as IMessage[]).some(
      (msg) => !msg.fromAgent && msg.createdAt && msg.createdAt.getTime() >= cutoff
    )
    if (!hasRecentParticipantActivity) {
      logger.debug(`${this.name}: no recent participant activity — skipping`)
      return {
        action: AgentMessageActions.REJECT,
        userMessage,
        userContributionVisible: false,
        suggestion: undefined
      }
    }
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
      channels: GROUP_CHAT_CHANNELS,
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

    // Format DM history grouped by channel so agent messages clearly show their recipient.
    // Without this, 50 separately-addressed checkins appear as 50 duplicate messages.
    const dmChannels = this.conversation.channels.filter((c: IChannel) => c.direct)
    await Promise.all(
      dmChannels.map((c) => (c as unknown as { populate(path: string): Promise<void> }).populate('participants'))
    )
    const privateMessagesText = formatDmHistoryByChannel(privateHistory.messages, dmChannels)

    const recentTranscript = transcript.getTranscript(this.conversation, 600, conversationHistory.end)
    const allMessages = [...sharedChatMessages.map((m) => m.content), privateMessagesText].join('\n')
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
        privateMessages: privateMessagesText || 'No private messages.',
        sharedChatHistory:
          sharedChatMessages.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content)).join('\n') ||
          'No shared chat messages yet.'
      },
      [],
      MODERATOR_SCHEMA
    )) as z.infer<typeof MODERATOR_SCHEMA>

    if (!analysis.shouldEscalate || analysis.confidenceScore < 60 || !analysis.observation) {
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
          value: analysis.observation,
          source: 'ai',
          recommendations: analysis.recommendations ?? [],
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

  formatTraceInput(conversationHistory: ConversationHistory) {
    return {
      transcript: conversationHistory.messages.map((m) => ({
        role: m.fromAgent ? 'agent' : 'participant',
        text: m.bodyType === 'json' ? (m.body as { text?: string })?.text : m.body,
        createdAt: m.createdAt
      }))
    }
  },

  formatTraceOutput(responses: AgentResponse<Record<string, unknown>>[]) {
    if (responses.length === 0) return { escalated: false, moderatorMessage: null }
    const insights = (responses[0].message as { insights?: { value: string }[] })?.insights
    return {
      escalated: true,
      moderatorMessage: insights?.[0]?.value ?? null
    }
  },

  getTraceMetadata(
    _conversationHistory: ConversationHistory,
    _userMessage: unknown,
    responses: AgentResponse<Record<string, unknown>>[]
  ) {
    return {
      topic: this.conversation.name,
      context: responses[0]?.context
    }
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
    return []
  },

  async onConversationEvent(evt: ConversationEvent): Promise<AgentResponse<Record<string, unknown>>[]> {
    if (evt.type !== 'conversationStarted') return []
    if (evt.conversationId !== this.conversation?._id?.toString()) return []
    access.assertCanRead(this, { type: 'conversation', id: evt.conversationId }, evt.type)

    // No configured pre-event window means no warm-up question was ever sent — skip straight
    // past the eventAssistant lookup and DB queries rather than running them just to find nothing.
    if (typeof this.conversation.preEventMinutes !== 'number' || this.conversation.preEventMinutes <= 0) return []

    const channel = this.conversation.channels?.find((c: IChannel) => c.name === 'moderator')
    if (!channel) return []

    try {
      const questionResults = await buildWarmUpQuestionResultsForModerator.call(this)
      if (!questionResults) return []
      // timestamp spans the window this report actually covers — the pregame period, not a
      // single instant — matching the other moderator message shapes' {start, end} field, so the
      // existing click-to-focus-transcript behavior in the moderator view keeps working here too.
      const scheduledTimeMs = new Date(this.conversation.scheduledTime).getTime()
      const windowStart = scheduledTimeMs - this.conversation.preEventMinutes * 60 * 1000
      return [
        {
          visible: true,
          // type identifies the message's own shape (questionResults vs. insights/metrics, which
          // have no type field and are instead inferred from which key is present) — distinct
          // from questionResults.questionType, which identifies which prompt this reports on.
          message: { type: 'questionResults', timestamp: { start: windowStart, end: Date.now() }, questionResults },
          messageType: 'json',
          channels: [channel]
        }
      ]
    } catch (err) {
      logger.error(`${this.name}: failed to build warm-up themes for moderator`, err)
      return []
    }
  }
})
