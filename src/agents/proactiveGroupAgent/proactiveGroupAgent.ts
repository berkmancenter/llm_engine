import { z } from 'zod'
import verify from '../helpers/verify.js'
import {
  AgentMessageActions,
  AgentResponse,
  BehaviorPolicy,
  ConversationHistory,
  ConversationGoal,
  IAgent,
  IChannel,
  IMessage
} from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import {
  USER_TEMPLATE,
  interventionLlmTemplateVars,
  runInterventionAnalysis,
  InterventionAnalysis
} from '../helpers/interventionHandler.js'
import getConversationHistory from '../helpers/getConversationHistory.js'
import logger from '../../config/logger.js'
import createAgentPoll from '../helpers/agentPoll.js'
import { getEligibleGoals, getMinContributionMs, composeSystemPrompt } from '../helpers/promptComposer.js'
import { getGroupChatGoals } from '../../goals/loader.js'
import validateProfessionalism from '../helpers/professionalismValidator.js'
import runSocraticStage from '../helpers/socraticPipeline.js'
import { validateSocraticSlots } from '../helpers/socraticSlots.js'
import transcript from '../helpers/transcript.js'
import { extractMessageText } from '../helpers/slashCommandParser.js'
import { getBackgroundContextForQuestion } from '../tools/resourceSearch.js'

const SOCRATIC_GOAL_ID = 'socratic_probe'
// Bounds for the reading-search query built from recent shared chat: a few messages, each
// clipped, so a long chat burst can't turn into an oversized embedding query.
const READING_QUERY_MESSAGES = 5
const READING_QUERY_MESSAGE_CHARS = 300
const READING_QUERY_MAX_CHARS = 1000

// Draws from both chat and transcript so a quiet chat during an active lecture/discussion still
// yields a query — chat alone would starve socratic_probe of input whenever no one is typing,
// even though it's marked silenceCompatible.
function buildReadingQuery(chatHistory: ConversationHistory, transcriptHistory: ConversationHistory): string {
  return [...chatHistory.messages, ...transcriptHistory.messages]
    .filter((m) => !m.fromAgent)
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0))
    .slice(-READING_QUERY_MESSAGES)
    .map((m) => {
      const text = extractMessageText(m)
      return typeof text === 'string' ? text.trim().slice(0, READING_QUERY_MESSAGE_CHARS) : ''
    })
    .filter(Boolean)
    .join('\n')
    .slice(-READING_QUERY_MAX_CHARS)
}

type SocraticSlotFields = { sourceLabel?: string | null; concept?: string | null; loadedWord?: string | null }

const SOCRATIC_CHAT_LINES = 8
const SOCRATIC_POSTS = 5

function recentTexts(history: ConversationHistory, fromAgent: boolean, count: number): string[] {
  return history.messages
    .filter((m) => Boolean(m.fromAgent) === fromAgent)
    .slice(-count)
    .map((m) => {
      const text = extractMessageText(m)
      return typeof text === 'string' ? text.trim() : ''
    })
    .filter(Boolean)
}

/** Pseudonyms of human participants, plus each one's last word (e.g. "Badger" for "Curious Badger"). */
function participantNameList(messages: IMessage[]): string[] {
  const names = new Set<string>()
  for (const m of messages) {
    if (m.fromAgent || !m.pseudonym) continue
    names.add(m.pseudonym)
    const last = m.pseudonym.trim().split(/\s+/).at(-1)
    if (last) names.add(last)
  }
  return [...names]
}

/**
 * Validates the decision call's slots, then has the passage-blind writer produce the question (with
 * a template fallback). Returns null to stay silent. The decision call's own message is never used.
 */
async function buildSocraticQuestion(
  this: IAgent & { getLLM: () => Promise<unknown> },
  analysis: SocraticSlotFields,
  sharedChatHistory: ConversationHistory,
  passage: string
): Promise<string | null> {
  const humanChatLines = recentTexts(sharedChatHistory, false, 15)
  const slotResult = validateSocraticSlots(analysis, {
    passage,
    resources: this.conversation.resources ?? [],
    humanChatLines
  })
  if (!slotResult.ok) {
    logger.warn(`${this.name}: ${SOCRATIC_GOAL_ID} slots rejected (${slotResult.reason}) — staying silent`)
    return null
  }
  const llm = await this.getLLM()
  const result = await runSocraticStage({
    llm,
    slots: slotResult.slots,
    passage,
    humanChatLines: humanChatLines.slice(-SOCRATIC_CHAT_LINES),
    recentPosts: recentTexts(sharedChatHistory, true, SOCRATIC_POSTS),
    participantNames: participantNameList((this.conversation.messages ?? []) as IMessage[])
  })
  return result?.message ?? null
}

function getProactiveSchema(goals: ConversationGoal[]) {
  const goalIdOptions = [...goals.map((g) => g.id), 'none'] as unknown as [string, ...string[]]
  const socraticSlots: z.ZodRawShape = goals.some((g) => g.id === SOCRATIC_GOAL_ID)
    ? {
        sourceLabel: z
          .string()
          .nullable()
          .optional()
          .describe(`For ${SOCRATIC_GOAL_ID} only: the author or title of the retrieved reading. Null otherwise.`),
        concept: z
          .string()
          .nullable()
          .optional()
          .describe(
            `For ${SOCRATIC_GOAL_ID} only: the passage's TOPIC or a term it names, as a 1-4 word noun phrase copied verbatim; never the name of something it found, and never an outcome, trend or comparison. Null otherwise.`
          ),
        loadedWord: z
          .string()
          .nullable()
          .optional()
          .describe(
            `For ${SOCRATIC_GOAL_ID} only: a word the group keeps using that the passage treats differently, else null.`
          )
      }
    : {}
  return z.object({
    ...socraticSlots,
    reasoning: z
      .string()
      .describe(
        'Internal analysis of what you see and why you are or are not intervening. Be concise — 3-5 sentences maximum.'
      ),
    shouldIntervene: z.boolean().describe('Whether an intervention is warranted at this moment'),
    goalId: z.enum(goalIdOptions).describe('The goal to apply, or "none" if no intervention is warranted'),
    sharedChatMessage: z
      .string()
      .nullable()
      .optional()
      .describe(
        'The message to post in shared chat. Must be a non-null string when shouldIntervene is true. Must be null when shouldIntervene is false.'
      ),
    confidenceScore: z.number().min(0).max(100).describe('Confidence in this intervention decision'),
    detectedPattern: z.string().nullable().optional().describe('Brief description of the pattern detected'),
    affectedUsers: z.number().nullable().optional().describe('Number of distinct users involved in the pattern')
  })
}

function getProactiveGroupSystemPrompt(goals: ConversationGoal[]): string {
  const goalIdsList = [...goals.map((g) => `"${g.id}"`), '"none"'].join(' | ')
  const readingRule = goals.some((g) => g.id === SOCRATIC_GOAL_ID)
    ? `
- "${SOCRATIC_GOAL_ID}" questions must be grounded in the "## Background Reading:" section of the user message. If that section is absent, do not use "${SOCRATIC_GOAL_ID}".
- For "${SOCRATIC_GOAL_ID}" do not write the question yourself: set sharedChatMessage to the single word "question" (a separate step writes the message from your slots, without seeing the passage). Instead fill: "sourceLabel" (just the author surname or the title, e.g. "Ostrom", with no year or full citation), "concept" (a short noun phrase of 1-4 words copied verbatim from the passage that NAMES the passage's topic or a term it uses, e.g. "procedural legitimacy" or "monitoring costs"; never the name of a phenomenon it found, an outcome, a sentence, a trend, or anything with a number or a verb like fell/rose/found/dropped/hurt/lower), and "loadedWord" (a word the group keeps repeating that the passage treats differently, otherwise null). Leave these null for other goals.`
    : ''

  return `You are an AI facilitator during a live event. You read participant messages and the live transcript, then decide whether to post in the shared group chat.

## Rules

PRIVACY:
- Never quote, paraphrase closely, or identify the source of any private message.
- Reference private messages only in aggregate — "several of you," "there's energy around..."
- If only one person raised something privately, do not surface it — wait for 2+ independent signals or until it appears publicly.
- Abstract themes so no individual could recognize their own words.
- Exception: a participant explicitly asks you to raise something on their behalf — you may do so, but still no attribution.

JUDGMENT:
- Intervene only when a trigger condition is clearly and currently true — not potentially true, not soon-to-be-true. "This discussion might stall" is not a trigger. "Participation is currently low with no back-and-forth" is a trigger.
- If participants are actively exchanging substantive messages with each other, stay quiet. This applies even if you could add something useful — adding to a working discussion is not your role.
- A speaker actively presenting is not the same as participants being active. If the transcript shows a speaker talking but there are few or no participant messages in chat, that is a passive room — consider whether a goal applies rather than waiting for participants to engage first.
- Do not treat the opening phase of an event as a reason to withhold. A silent room during introductions is a valid state to act on — you do not need to wait for substantive topic discussion to begin before checking whether a goal applies.
- Prioritize the present moment. History is context; act on what just happened.
- Don't re-raise a theme that has already run its course or that you've made recently without meaningful development since.
- Vary the goals you apply. Don't overuse any single one.${readingRule}

## Output Format

Return a JSON object:

{{
  "reasoning": "Internal analysis — not posted to chat. 3-5 sentences max.",
  "shouldIntervene": boolean,
  "goalId": ${goalIdsList},
  "sharedChatMessage": "Message for shared chat — non-null string if shouldIntervene is true, null otherwise",
  "confidenceScore": 0-100,
  "detectedPattern": "Brief pattern description (null if none)",
  "affectedUsers": number (use 0 if no users affected)
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`
}

/* A no-intervention tick (the common case) returns this instead of [] so the model's reasoning
   for staying quiet still reaches the LangSmith trace — in prod, with debug logging off, it
   would otherwise only exist in the (unlogged) logger.debug calls below. traceOnly tells
   agent.model/index.ts's respond() wrapper to keep it out of the job handler that turns ordinary
   responses into real Messages, while formatTraceOutput still reads it like any other response. */
function buildTraceOnlyResponse(analysis: InterventionAnalysis) {
  return {
    // Spread at the top level too, matching the real-intervention response below — so
    // formatTraceOutput's existing r.reasoning/r.confidenceScore/etc. reads need no special
    // case for this path. sharedChatMessage is nulled out regardless of what the model proposed:
    // this response represents nothing having actually been sent.
    ...analysis,
    sharedChatMessage: null,
    visible: false,
    traceOnly: true,
    messageType: 'json',
    message: {
      goalId: analysis.goalId,
      reasoning: analysis.reasoning,
      confidenceScore: analysis.confidenceScore,
      detectedPattern: analysis.detectedPattern
    }
  }
}

async function executePoll(
  this: IAgent & { getLLM: () => Promise<unknown> },
  analysis: InterventionAnalysis,
  chatChannels: IChannel[],
  goal: ConversationGoal
) {
  try {
    const result = await createAgentPoll.call(
      this,
      analysis.detectedPattern ?? 'Create a poll',
      analysis.context ?? '',
      goal.outputContract.pollConfig ?? {},
      goal.outputContract.pollInstructions
    )
    if (result) {
      logger.info('proactiveGroupAgent: poll intervention executed')
      return [
        {
          ...analysis,
          visible: true,
          proactive: true,
          message: result,
          messageType: 'json',
          channels: chatChannels
        }
      ]
    }
  } catch (error) {
    logger.error('proactiveGroupAgent: Failed to create poll via tool', error)
  }
  return [buildTraceOnlyResponse(analysis)]
}

function resolveActiveGoals(conversation: { goals?: string[]; behaviorPolicy?: BehaviorPolicy }): ConversationGoal[] {
  const groupChatPolicy = conversation.behaviorPolicy?.channels?.groupChat
  return getEligibleGoals(conversation.goals, groupChatPolicy)
}

export default verify({
  name: 'Proactive Group Agent',
  description:
    'Makes strategic interventions in shared chat based on active behavioral patterns — facilitating discussion, surfacing signal, and generating engagement based on conversation goals.',
  priority: 85,
  // Response cap for the model call itself; the longest outputs (5-choice polls) run ~600 tokens,
  // and thinking shares this budget on Claude models.
  maxTokens: 10000,
  defaultTriggers: {
    periodic: { timerPeriod: 120, conversationHistorySettings: { channels: ['transcript'] }, proactive: true }
  },
  agentConfig: {
    personality: 'sarcastic-expert',
    transcriptWindow: 10 // transcript window in minutes
  },
  llmTemplateVars: interventionLlmTemplateVars,
  defaultLLMTemplates: {
    system: '',
    user: USER_TEMPLATE
  },
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,

  // Chat interventions carry a goal label in a JSON body; adapters that only forward plain
  // text (Zoom) get just the text instead. Polls are exempt — they need their JSON body intact
  // for zoom.ts's own poll-link handling.
  parseOutput: (msg) => {
    if (msg.bodyType === 'text' || msg.body?.type === 'poll') {
      return msg
    }
    const translatedMsg = msg.toObject()
    translatedMsg.bodyType = 'text'
    translatedMsg.body = msg.body.text
    return translatedMsg
  },

  async evaluate(userMessage: unknown) {
    // This agent is proactive (triggers.periodic.proactive), so the framework's own
    // evaluate() never applies its "no new messages" skip — see agent.model/index.ts.
    // Some of this agent's goals (provoke_participation, play_commentary, poll_reveal,
    // missing_perspective) trigger ON chat silence, so a blanket "skip if quiet" gate
    // would disable their entire purpose. This checks chat and transcript separately and
    // only skips when neither has anything for ANY eligible goal to react to.
    const windowMs = ((this.agentConfig?.transcriptWindow as number | undefined) ?? 10) * 60 * 1000
    const cutoff = Date.now() - windowMs
    const messages = (this.conversation.messages ?? []) as IMessage[]
    const hasRecentChat = messages.some(
      (m) => !m.fromAgent && m.channels?.includes('chat') && m.createdAt && m.createdAt.getTime() >= cutoff
    )
    const hasRecentTranscript = messages.some(
      (m) => m.channels?.includes('transcript') && m.createdAt && m.createdAt.getTime() >= cutoff
    )

    if (!hasRecentChat && !hasRecentTranscript) {
      logger.debug(`${this.name}: chat and transcript both quiet — skipping`)
      return {
        action: AgentMessageActions.REJECT,
        userMessage,
        userContributionVisible: false,
        suggestion: undefined
      }
    }
    if (!hasRecentChat && hasRecentTranscript) {
      const groupChatGoals = getGroupChatGoals(resolveActiveGoals(this.conversation))
      const silenceCompatible = groupChatGoals.some((g) => g.silenceCompatible)
      if (!silenceCompatible) {
        logger.debug(`${this.name}: chat quiet, no silence-compatible goal eligible — skipping`)
        return {
          action: AgentMessageActions.REJECT,
          userMessage,
          userContributionVisible: false,
          suggestion: undefined
        }
      }
    }
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory): Promise<AgentResponse<string | Record<string, unknown>>[]> {
    const transcriptWindowSeconds = ((this.agentConfig?.transcriptWindow as number | undefined) ?? 10) * 60
    const recentTranscript = transcript.getTranscript(this.conversation, transcriptWindowSeconds, conversationHistory.end)

    const activeGoals = resolveActiveGoals(this.conversation)
    const groupChatGoals = getGroupChatGoals(activeGoals)

    if (groupChatGoals.length === 0) {
      logger.debug(`${this.name}: No active group chat goals — skipping`)
      return []
    }

    const groupChatPolicy = this.conversation.behaviorPolicy?.channels?.groupChat
    if (groupChatPolicy?.proactivePolicy?.initiativeLevel === 'passive') {
      logger.debug(`${this.name}: Initiative level is passive — skipping`)
      return []
    }

    const personalityName = this.agentConfig?.personality ?? null
    const goalPriorities = this.agentConfig?.goalPriorities as Record<string, number> | undefined
    const goalContext = this.agentConfig?.goalContext as Record<string, string> | undefined
    const sharedChatHistory = getConversationHistory(this.conversation.messages, {
      count: 100,
      channels: ['chat'],
      endTime: conversationHistory.end
    })

    const minInterval = getMinContributionMs(groupChatPolicy?.proactivePolicy, this.agentConfig)
    const lastGroupIntervention = sharedChatHistory.messages
      .filter((m) => m.fromAgent && m.visible && m.pseudonym === this.instanceName)
      .at(-1)
    const now = sharedChatHistory.end ? sharedChatHistory.end.getTime() : Date.now()
    const baseline = lastGroupIntervention
      ? lastGroupIntervention.createdAt!.getTime()
      : new Date(this.conversation.startTime).getTime()
    // Grace buffer accounts for LLM execution time between the rate-limit check and message creation.
    // When minInterval equals the timer period, dissolve the check entirely (grace = minInterval)
    // so every cycle is eligible. When minInterval exceeds the timer period, use a small fixed
    // buffer for LLM latency only — preserving the intent of the longer minimum.
    const timerPeriodMs = (this.triggers?.periodic?.timerPeriod ?? 120) * 1000
    const RATE_LIMIT_GRACE_MS = minInterval <= timerPeriodMs ? minInterval : 30 * 1000
    if (now - baseline < minInterval - RATE_LIMIT_GRACE_MS) {
      logger.debug(
        `${this.name}: Rate limited — last intervention ${Math.round((now - baseline) / 1000)}s ago (min ${
          minInterval / 1000
        }s)`
      )
      return []
    }

    const privateHistory = getConversationHistory(
      this.conversation.messages,
      { count: 100, directMessages: true, endTime: conversationHistory.end },
      null,
      this.conversation.channels.filter((c: IChannel) => c.direct).map((c: IChannel) => c.name)
    )

    // Prefetch only once we are about to call the LLM. socratic_probe is hard-gated: it is only
    // offered to the model when passages were actually retrieved, so it can never fire ungrounded
    // (no resources, empty/failed retrieval, or nothing to query with).
    let backgroundReading: string | undefined
    if (groupChatGoals.some((g) => g.id === SOCRATIC_GOAL_ID) && this.conversation.resources?.some((r) => r.fileName)) {
      const transcriptHistory = getConversationHistory(this.conversation.messages, {
        count: 100,
        channels: ['transcript'],
        endTime: conversationHistory.end
      })
      const query = buildReadingQuery(sharedChatHistory, transcriptHistory)
      if (query) {
        try {
          backgroundReading = (await getBackgroundContextForQuestion(String(this.conversation._id), query)) || undefined
        } catch (error) {
          logger.warn(`${this.name}: background reading prefetch failed — continuing without`, error)
        }
      }
    }

    const eligibleGoals = backgroundReading ? groupChatGoals : groupChatGoals.filter((g) => g.id !== SOCRATIC_GOAL_ID)
    if (eligibleGoals.length === 0) {
      logger.debug(`${this.name}: only ${SOCRATIC_GOAL_ID} is active and no reading passages were retrieved — skipping`)
      return []
    }

    const systemPrompt = composeSystemPrompt(getProactiveGroupSystemPrompt(eligibleGoals), {
      conversationContext: this.conversation.conversationContext,
      behaviorPolicy: this.conversation.behaviorPolicy,
      goals: eligibleGoals,
      channelType: 'groupChat',
      personalityName,
      goalPriorities,
      goalContext
    })

    const analysis = (await runInterventionAnalysis.call(
      this,
      sharedChatHistory,
      systemPrompt,
      getProactiveSchema(eligibleGoals),
      privateHistory,
      undefined,
      undefined,
      eligibleGoals,
      this.conversation.behaviorPolicy,
      'groupChat',
      recentTranscript,
      goalPriorities,
      backgroundReading
    )) as unknown as InterventionAnalysis & SocraticSlotFields

    if (analysis.goalId === 'none') {
      logger.debug(`${this.agentType} ${this._id}: decision returned goal none — no intervention`)
      return [buildTraceOnlyResponse(analysis)]
    }

    if (analysis.goalId === SOCRATIC_GOAL_ID && !backgroundReading) {
      logger.warn(`${this.name}: ${SOCRATIC_GOAL_ID} chosen without retrieved passages — discarding`)
      return [buildTraceOnlyResponse(analysis)]
    }

    if (analysis.goalId === SOCRATIC_GOAL_ID && backgroundReading) {
      const question = await buildSocraticQuestion.call(this, analysis, sharedChatHistory, backgroundReading)
      if (!question) return [buildTraceOnlyResponse(analysis)]
      analysis.sharedChatMessage = question
    }

    if (this.conversation.behaviorPolicy?.globalPolicy?.safetyPosture === 'strict' && analysis.sharedChatMessage) {
      const llm = await this.getLLM()
      const isAppropriate = await validateProfessionalism(
        llm,
        analysis.sharedChatMessage,
        this.conversation.name,
        analysis.goalId,
        recentTranscript
      )
      if (!isAppropriate) {
        logger.warn(`${this.name}: intervention rejected by professionalism guardrail (goal: ${analysis.goalId})`)
        return [buildTraceOnlyResponse(analysis)]
      }
    }

    const chatChannels = this.conversation.channels.filter((c: IChannel) => c.name === 'chat')

    const matchedGoal = eligibleGoals.find((g) => g.id === analysis.goalId)
    if (matchedGoal?.outputContract.format === 'poll') {
      logger.info(`${this.name}: Detected ${analysis.goalId} opportunity — ${analysis.detectedPattern}`)
      return executePoll.call(this, analysis, chatChannels, matchedGoal)
    }

    if (!analysis.sharedChatMessage) {
      logger.warn(`${this.name}: shouldIntervene=true (${analysis.goalId}) but sharedChatMessage is missing — suppressing`)
      return [buildTraceOnlyResponse(analysis)]
    }

    logger.info(`${this.name}: Detected ${analysis.goalId} opportunity — ${analysis.detectedPattern}`)
    return [
      {
        ...analysis,
        visible: true,
        proactive: true,
        message: { text: analysis.sharedChatMessage, goal: matchedGoal?.label },
        messageType: 'json',
        channels: chatChannels
      } as AgentResponse<string | Record<string, unknown>>
    ]
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  formatTraceInput(_conversationHistory: ConversationHistory) {
    return {
      behaviorPolicy: this.conversation.behaviorPolicy,
      goals: getGroupChatGoals(resolveActiveGoals(this.conversation)),
      conversationContext: this.conversation.conversationContext,
      personality: this.agentConfig?.personality ?? null
    }
  },

  formatTraceOutput(responses: InterventionAnalysis[]) {
    // Includes traceOnly responses (buildTraceOnlyResponse above) — those carry the model's
    // reasoning for staying quiet the same shape as a real intervention does, so no separate
    // branch is needed here; only a genuine "no analysis ran at all" tick reaches length === 0.
    if (responses.length === 0) return { goalId: 'none', messageSent: null, context: null, reasoning: null }
    const r = responses[0]
    const activeGoals = getGroupChatGoals(resolveActiveGoals(this.conversation))
    const matchedGoal = activeGoals.find((g) => g.id === r.goalId) ?? null
    return {
      goalId: r.goalId,
      goal: matchedGoal,
      reasoning: r.reasoning,
      confidenceScore: r.confidenceScore,
      detectedPattern: r.detectedPattern,
      messageSent: r.sharedChatMessage,
      context: r.context
    }
  },

  getTraceMetadata() {
    return {
      topic: this.conversation.name,
      // Lets production telemetry show whether real conversations are actually curating
      // goal sets (vs. all using the same platform default) — needed to size the real
      // hit rate of the silence-compatible-goal check in evaluate() above.
      activeGoalIds: getGroupChatGoals(resolveActiveGoals(this.conversation)).map((g) => g.id)
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
  }
})
