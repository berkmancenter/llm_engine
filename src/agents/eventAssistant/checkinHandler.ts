import { z } from 'zod'
import {
  BehaviorPolicy,
  ConversationContext,
  ConversationGoal,
  ConversationHistory,
  IChannel,
  TriggerCondition
} from '../../types/index.types.js'

import getConversationHistory from '../helpers/getConversationHistory.js'
import { detectPrivateInterventionOpportunity, InterventionAnalysis } from '../helpers/interventionHandler.js'
import { formatDmHistoryByChannel } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import logger from '../../config/logger.js'
import filterHallucinations from '../helpers/hallucinations.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { getDmGoals } from '../../goals/loader.js'
import { getEligibleGoals, composeSystemPrompt, getMinContributionMs } from '../helpers/promptComposer.js'
import config from '../../config/config.js'

interface AgentLike {
  agentConfig?: { minInterval?: number; [key: string]: unknown }
  triggers?: { periodic?: { timerPeriod?: number } }
  conversation: {
    channels: IChannel[]
    behaviorPolicy?: BehaviorPolicy
    conversationContext?: ConversationContext
    [key: string]: unknown
  }
  getLLM(): Promise<unknown>
  name: string
}

const eventConditionSchema = z.object({
  passed: z.boolean().describe('Whether the condition is currently true'),
  detail: z.string().nullable().describe('Optional elaboration — e.g. the specific topic or aspect that makes this true')
})

const CHECKIN_USER_TEMPLATE = `## Event Topic:
{topic}

## You are writing to:
{participantPseudonym}

## This Participant's DM History:
{thisParticipantHistory}

## Recent Transcript (last 10 minutes):
{recentTranscript}

## Event Signals:
{eventSignals}

## Retrieved Relevant Context from Transcript:
{retrievedChunks}

## Private Messages (All Participants):
{privateMessages}

## Shared Chat History:
{sharedChatHistory}

## Your Recent Posts:
{agentRecentPosts}

---

Analyze the current state and determine if a check-in is warranted. Follow the decision framework and output valid JSON only.`

/**
 * Evaluates a single event-scoped condition once using the recent transcript.
 * Returns { passed, detail } so the result can gate goals and provide context to the LLM.
 */
async function evaluateEventCondition(
  agentInstance: AgentLike,
  condition: string,
  recentTranscript: string
): Promise<{ passed: boolean; detail: string | null }> {
  if (!recentTranscript?.trim()) return { passed: false, detail: null }

  try {
    const llm = await agentInstance.getLLM()
    return await getChatPromptResponse(
      llm,
      'You are evaluating whether a condition about a live event is currently true, based on the recent transcript. Return only JSON.',
      'Condition: {condition}\n\nRecent transcript:\n{recentTranscript}\n\nIs this condition currently true?',
      { condition, recentTranscript },
      [],
      eventConditionSchema
    )
  } catch (err) {
    logger.warn(`[checkinHandler] event condition evaluation failed for "${condition}": ${err}`)
    return { passed: false, detail: null }
  }
}

/**
 * Evaluates all unique event-scoped conditions across active goals once in parallel.
 * Returns a map of condition → result and a formatted summary string for the LLM prompt.
 */
async function resolveEventConditions(
  agentInstance: AgentLike,
  goals: ConversationGoal[],
  recentTranscript: string
): Promise<{ results: Map<string, { passed: boolean; detail: string | null }>; summary: string }> {
  const unique = [
    ...new Map(
      goals
        .flatMap((g) => g.triggers.conditions)
        .filter((c): c is TriggerCondition & { scope: 'event' } => c.scope === 'event')
        .map((c) => [c.condition, c])
    ).values()
  ]

  if (unique.length === 0) return { results: new Map(), summary: 'No event-level signals to report.' }

  const entries = await Promise.all(
    unique.map(
      async (c) => [c.condition, await evaluateEventCondition(agentInstance, c.condition, recentTranscript)] as const
    )
  )

  const results = new Map(entries)
  const summary = entries
    .map(([condition, { passed, detail }]) => `- ${condition}: ${passed ? 'Yes' : 'No'}${detail ? ` (${detail})` : ''}`)
    .join('\n')

  for (const [condition, { passed, detail }] of entries) {
    logger.debug(`[checkinHandler] event condition "${condition.slice(0, 60)}…": ${passed ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`)
  }

  return { results, summary }
}

function filterGoalsByEventConditions(
  goals: ConversationGoal[],
  eventResults: Map<string, { passed: boolean; detail: string | null }>
): ConversationGoal[] {
  return goals.filter((goal) =>
    goal.triggers.conditions.filter((c) => c.scope === 'event').every((c) => eventResults.get(c.condition)?.passed === true)
  )
}

function filterGoalsByParticipantRequirements(
  goals: ConversationGoal[],
  participantMessageCount: number
): ConversationGoal[] {
  return goals.filter((goal) => {
    const min = goal.triggers.participantRequirements?.minMessageCount
    return min === undefined || participantMessageCount >= min
  })
}

function buildCheckinSystemPrompt(
  activeGoals: ConversationGoal[],
  behaviorPolicy?: BehaviorPolicy,
  conversationContext?: ConversationContext,
  personalityName?: string | null
): string {
  const base = `You are a supportive AI assistant at a live event, reaching out privately to individual participants when there is a meaningful reason to do so.

## Who you are writing to
You are composing a private message for the participant identified at the top of the prompt. The "Private Messages" section contains DMs from all participants — use the others only to understand shared patterns, never as content to surface directly.

Calibrate your language register to this participant's own messages — vocabulary, question style, and level of detail are your primary signal. The event's audience profile is a starting point for participants who have not yet written anything.

## What you are looking at
- This participant's DM history — their own conversation with you, for direct reference
- Shared chat history — includes the participant's public activity
- Private messages (all participants) — use only to understand shared patterns
- Event Signals — pre-evaluated conditions about the current state of the event (e.g. transcript density)

## Rules

- Write only to the identified participant — the directMessage field is sent privately to them alone
- Never mention that you analyzed messages or used AI to detect patterns
- Never quote or closely paraphrase any participant's words
- Never name or hint at any other participant
- Before sending, check your recent posts: have you already said something similar to this participant? If so, choose none unless their situation has meaningfully evolved since then.
- Never repeat a theme unless something has genuinely changed — a new signal, a new message, a new pattern.
- Vary the goals you apply.
- Every question is worth asking — never imply otherwise.`

  return composeSystemPrompt(base, {
    conversationContext,
    behaviorPolicy,
    goals: activeGoals,
    channelType: 'dm',
    personalityName
  })
}

function getCheckinDmAnalysisSchema(activeGoals: ConversationGoal[]) {
  const goalIdOptions = [...activeGoals.map((g) => g.id), 'none'] as unknown as [string, ...string[]]
  return z.object({
    reasoning: z
      .string()
      .describe('Internal analysis of what signals you detected and why you are or are not sending a message'),
    shouldIntervene: z.boolean().describe('Whether to send a check-in message'),
    goalId: z.enum(goalIdOptions).describe('The goal to apply, or "none" if no message is warranted'),
    directMessage: z
      .string()
      .nullable()
      .optional()
      .describe('The direct message to send to this participant, if shouldIntervene is true'),
    confidenceScore: z.number().min(0).max(100).describe('Confidence in this decision'),
    detectedPattern: z.string().nullable().optional().describe('Brief description of the pattern detected'),
    sourceMessages: z
      .array(
        z.object({
          participant: z.string().describe('Pseudonym of the participant'),
          text: z
            .string()
            .describe(
              'The specific text from their message that supports this claim — must be a close quote, not a paraphrase'
            )
        })
      )
      .nullable()
      .optional()
      .describe(
        'Required (non-null) whenever your message implies others share this view, feeling, or interest — e.g. "others are privately feeling the same", "a few people have asked about this". Your message will be suppressed if you claim cross-participant evidence without providing it here. Leave null only if the message is solely about this participant with no reference to others.'
      )
  })
}

/**
 * Processes a single participant's DM channel: applies goal filters, calls the LLM,
 * validates hallucinations, and returns a response object or null.
 */
async function processParticipant(
  this: AgentLike & { _id: string; agentType: string },
  channel: IChannel,
  conversationHistory: ConversationHistory,
  eligibleGoals: ConversationGoal[],
  allDmHistory: ConversationHistory,
  sharedChatHistory: ConversationHistory,
  eventSignals: string,
  recentTranscript: string
) {
  const channelMessages = conversationHistory.messages.filter((m) => m.channels?.includes(channel.name))
  const participantDmHistory = getConversationHistory(channelMessages, { count: 50, endTime: conversationHistory.end })

  const participantMessageCount = participantDmHistory.messages.filter((m) => !m.fromAgent).length
  const goalsToPursue = filterGoalsByParticipantRequirements(eligibleGoals, participantMessageCount)

  if (goalsToPursue.length === 0) {
    const pseudonym = channelMessages.find((m) => !m.fromAgent)?.pseudonym ?? 'participant'
    logger.debug(`[checkinHandler] no eligible goals for ${pseudonym} — skipping LLM call`)
    return null
  }

  // Resolve pseudonym from message history first; fall back to channel.participants for users
  // who haven't sent any DMs yet (e.g. transcript hook targets quiet participants).
  const participantPseudonym =
    channelMessages.find((m) => !m.fromAgent)?.pseudonym ||
    channel.participants?.find((p) => p._id?.toString() !== this._id.toString())?.activePseudonym?.pseudonym ||
    'participant'

  const thisParticipantHistory =
    participantDmHistory.messages.length > 0
      ? formatDmHistoryByChannel(participantDmHistory.messages, [channel])
      : 'No messages yet from this participant.'

  const { behaviorPolicy, conversationContext } = this.conversation
  const personalityName = (this.agentConfig?.personality as string | null | undefined) ?? (config.enableAgentPersonality ? 'sarcastic-expert' : null)
  const systemPrompt = buildCheckinSystemPrompt(goalsToPursue, behaviorPolicy, conversationContext, personalityName)
  const schema = getCheckinDmAnalysisSchema(goalsToPursue)

  const analysis = (await detectPrivateInterventionOpportunity.call(
    this,
    sharedChatHistory,
    systemPrompt,
    schema,
    allDmHistory,
    participantDmHistory,
    CHECKIN_USER_TEMPLATE,
    { participantPseudonym, thisParticipantHistory, eventSignals },
    goalsToPursue,
    behaviorPolicy,
    recentTranscript
  )) as unknown as InterventionAnalysis | null

  if (!analysis?.directMessage) {
    logger.debug(`${this.agentType} ${this._id}: no check-in warranted for ${participantPseudonym}`)
    return null
  }

  // Verify any cited cross-participant messages are real — mirrors backChannel hallucination filtering.
  if (analysis.sourceMessages?.length) {
    const otherMessages = [...allDmHistory.messages, ...sharedChatHistory.messages].filter(
      (m) => !m.fromAgent && m.pseudonym !== participantPseudonym
    )
    if (!filterHallucinations(analysis.sourceMessages, otherMessages)) {
      logger.warn(
        `CheckinHandler: suppressed hallucinated cross-participant claim for ${participantPseudonym}: cited ${JSON.stringify(
          analysis.sourceMessages
        )}`
      )
      return null
    }
  }

  logger.info(`Checkin Handler: ${analysis.goalId} → ${participantPseudonym} (${channel.name}): ${analysis.detectedPattern}`)
  return {
    visible: true,
    message: { type: 'checkin', text: analysis.directMessage },
    messageType: 'json',
    channels: [channel],
    context: analysis.context,
    participantPseudonym,
    eligibleGoals: goalsToPursue.map((g) => g.id),
    goalId: analysis.goalId,
    reasoning: analysis.reasoning,
    confidenceScore: analysis.confidenceScore,
    detectedPattern: analysis.detectedPattern
  }
}

/**
 * Main entry point called from eventAssistant.respond() when triggered periodically.
 * Iterates over each participant's DM channel and decides whether to send a check-in.
 * Called with `this` = agent instance.
 */
export default async function buildCheckinResponses(conversationHistory: ConversationHistory) {
  // Populate participants so pseudonym fallback in formatDmHistoryByChannel has full user docs.
  const directChannelList = this.conversation.channels.filter((c: IChannel) => c.direct)
  await Promise.all(
    directChannelList.map((c: IChannel) =>
      (c as unknown as { populate(path: string): Promise<void> }).populate('participants')
    )
  )

  // De-dup by name — React StrictMode can produce duplicate channels in development.
  const directChannels: IChannel[] = Array.from(
    new Map<string, IChannel>(
      directChannelList
        .filter((channel: IChannel) => channel.participants?.some((p) => p._id?.toString() === this._id.toString()))
        .map((channel: IChannel) => [channel.name, channel])
    ).values()
  )

  if (directChannels.length === 0) return []

  // If every participant was messaged recently, skip the shared LLM evaluations entirely.
  const now = conversationHistory.end ? conversationHistory.end.getTime() : Date.now()
  const dmProactivePolicy = this.conversation.behaviorPolicy?.channels?.dm?.proactivePolicy
  const minInterval = getMinContributionMs(dmProactivePolicy, this.agentConfig)
  const conversationStart = new Date(this.conversation.startTime).getTime()
  const anyEligible = directChannels.some((channel) => {
    const lastAgentMsg = conversationHistory.messages
      .filter((m) => m.channels?.includes(channel.name) && m.fromAgent && m.visible)
      .at(-1)
    const baseline = lastAgentMsg ? new Date(lastAgentMsg.createdAt!).getTime() : conversationStart
    return now - baseline >= minInterval
  })

  if (!anyEligible) {
    logger.debug('CheckinHandler: all participants rate-limited — skipping')
    return []
  }

  if (dmProactivePolicy?.initiativeLevel === 'passive') {
    logger.debug('CheckinHandler: DM initiative level is passive — skipping')
    return []
  }

  const transcriptWindowSeconds = ((this.agentConfig?.checkinTranscriptWindow as number | undefined) ?? 3) * 60
  const recentTranscript = transcript.getTranscript(this.conversation, transcriptWindowSeconds, conversationHistory.end)

  const sharedChatHistory = getConversationHistory(conversationHistory.messages, {
    count: 100,
    channels: ['chat'],
    endTime: conversationHistory.end
  })

  const allDmHistory = getConversationHistory(
    conversationHistory.messages,
    { count: 100, directMessages: true, endTime: conversationHistory.end },
    null,
    directChannelList.map((c: IChannel) => c.name)
  )

  const activeDmGoals = getDmGoals(getEligibleGoals(this.conversation.goals ?? []))

  if (activeDmGoals.length === 0) {
    logger.debug('CheckinHandler: no active DM goals — skipping')
    return []
  }

  // Evaluate event-scoped conditions once — gates which goals reach the participant loop
  // and injects pre-computed signals as context for every participant's LLM call.
  const { results: eventResults, summary: eventSignals } = await resolveEventConditions(
    this,
    activeDmGoals,
    recentTranscript
  )
  const eventEligibleGoals = filterGoalsByEventConditions(activeDmGoals, eventResults)

  if (eventEligibleGoals.length === 0) {
    logger.debug('CheckinHandler: no goals passed event conditions — skipping')
    return []
  }

  const results = await Promise.all(
    directChannels.map((channel) =>
      processParticipant.call(
        this,
        channel,
        conversationHistory,
        eventEligibleGoals,
        allDmHistory,
        sharedChatHistory,
        eventSignals,
        recentTranscript
      )
    )
  )

  return results.filter(Boolean)
}
