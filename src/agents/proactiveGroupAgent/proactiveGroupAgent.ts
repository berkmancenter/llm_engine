import { z } from 'zod'
import verify from '../helpers/verify.js'
import {
  AgentMessageActions,
  AgentResponse,
  BehaviorPolicy,
  ConversationHistory,
  ConversationGoal,
  IAgent,
  IChannel
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
import transcript from '../helpers/transcript.js'

function getProactiveSchema(goals: ConversationGoal[]) {
  const goalIdOptions = [...goals.map((g) => g.id), 'none'] as unknown as [string, ...string[]]
  return z.object({
    shouldIntervene: z.boolean().describe('Whether an intervention is warranted at this moment'),
    goalId: z.enum(goalIdOptions).describe('The goal to apply, or "none" if no intervention is warranted'),
    reasoning: z.string().describe('Internal analysis of what you see and why you are or are not intervening'),
    sharedChatMessage: z
      .string()
      .nullable()
      .optional()
      .describe('The message to post in shared chat, if shouldIntervene is true'),
    confidenceScore: z.number().min(0).max(100).describe('Confidence in this intervention decision'),
    detectedPattern: z.string().nullable().optional().describe('Brief description of the pattern detected'),
    affectedUsers: z.number().nullable().optional().describe('Number of distinct users involved in the pattern')
  })
}

function getProactiveGroupSystemPrompt(goals: ConversationGoal[]): string {
  const goalIdsList = [...goals.map((g) => `"${g.id}"`), '"none"'].join(' | ')

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
- A speaker actively presenting is not the same as participants being active. If the transcript shows a speaker talking but there are few or no participant messages in chat, that is a passive room — treat it as low participation regardless of how much content the speaker is delivering.
- Silence is a valid output. Most cycles should produce no intervention.
- Prioritize the present moment. History is context; act on what just happened.
- Before posting, check: Have I already said this? Did it land? How recently did I post?
- Never repeat a theme unless it has meaningfully evolved.
- Build on posts that got engagement. Drop topics that fell flat.
- Vary the goals you apply. Don't overuse any single one.

## Output Format

Return a JSON object:

{{
  "shouldIntervene": boolean,
  "goalId": ${goalIdsList},
  "reasoning": "Internal analysis — not posted to chat",
  "sharedChatMessage": "Message for shared chat (null if not intervening)",
  "confidenceScore": 0-100,
  "detectedPattern": "Brief pattern description (null if none)",
  "affectedUsers": number (use 0 if no users affected)
}}

Return ONLY raw JSON. No markdown, no backticks, no explanation.`
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
  return []
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
  maxTokens: 3000,
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

  async evaluate(userMessage: unknown) {
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
    const systemPrompt = composeSystemPrompt(getProactiveGroupSystemPrompt(groupChatGoals), {
      conversationContext: this.conversation.conversationContext,
      behaviorPolicy: this.conversation.behaviorPolicy,
      goals: groupChatGoals,
      channelType: 'groupChat',
      personalityName
    })

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
    // Without it, messages created 10-30s after the check causes the next periodic tick to be
    // slightly under the interval and rate-limit every other invocation.
    const RATE_LIMIT_GRACE_MS = 20 * 1000
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

    const analysis = (await runInterventionAnalysis.call(
      this,
      sharedChatHistory,
      systemPrompt,
      getProactiveSchema(groupChatGoals),
      privateHistory,
      undefined,
      undefined,
      groupChatGoals,
      this.conversation.behaviorPolicy,
      'groupChat',
      recentTranscript
    )) as unknown as InterventionAnalysis | null

    if (!analysis) {
      logger.debug(`${this.agentType} ${this._id}: no intervention opportunity detected`)
      return []
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
        return []
      }
    }

    const chatChannels = this.conversation.channels.filter((c: IChannel) => c.name === 'chat')

    const matchedGoal = groupChatGoals.find((g) => g.id === analysis.goalId)
    if (matchedGoal?.outputContract.format === 'poll') {
      logger.info(`${this.name}: Detected ${analysis.goalId} opportunity — ${analysis.detectedPattern}`)
      return executePoll.call(this, analysis, chatChannels, matchedGoal)
    }

    if (!analysis.sharedChatMessage) {
      logger.warn(`${this.name}: shouldIntervene=true (${analysis.goalId}) but sharedChatMessage is missing — suppressing`)
      return []
    }

    logger.info(`${this.name}: Detected ${analysis.goalId} opportunity — ${analysis.detectedPattern}`)
    return [
      {
        ...analysis,
        visible: true,
        proactive: true,
        message: analysis.sharedChatMessage,
        channels: chatChannels
      } as AgentResponse<string | Record<string, unknown>>
    ]
  },

  formatTraceInput(conversationHistory: ConversationHistory) {
    return {
      transcript: conversationHistory.messages.map((m) => ({
        role: m.fromAgent ? 'agent' : 'participant',
        pseudonym: m.pseudonym,
        text: m.bodyType === 'json' ? (m.body as { text?: string })?.text : m.body,
        createdAt: m.createdAt
      }))
    }
  },

  formatTraceOutput(responses: InterventionAnalysis[]) {
    if (responses.length === 0) return { goalId: 'none', messageSent: null }
    const r = responses[0]
    return {
      goalId: r.goalId,
      reasoning: r.reasoning,
      confidenceScore: r.confidenceScore,
      detectedPattern: r.detectedPattern,
      messageSent: r.sharedChatMessage
    }
  },

  getTraceMetadata(_conversationHistory: ConversationHistory, _userMessage: unknown, responses: InterventionAnalysis[]) {
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
  }
})
