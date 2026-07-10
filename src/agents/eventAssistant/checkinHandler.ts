import { z } from 'zod'
import { ConversationHistory, IChannel } from '../../types/index.types.js'

import getConversationHistory from '../helpers/getConversationHistory.js'
import { detectPrivateInterventionOpportunity, buildInterventionTypeSection } from '../helpers/interventionHandler.js'
import { formatDmHistoryByChannel } from '../helpers/llmInputFormatters.js'
import logger from '../../config/logger.js'
import filterHallucinations from '../helpers/hallucinations.js'
import transcript from '../helpers/transcript.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'

interface AgentLike {
  agentConfig?: { minInterval?: number; [key: string]: unknown }
  triggers?: { periodic?: { timerPeriod?: number } }
  conversation: { channels: IChannel[]; [key: string]: unknown }
  getLLM(): Promise<unknown>
  name: string
}

/**
 * Types of private check-in interventions the agent can send to individual participants.
 * Distinct from InterventionType (public chat interventions)
 *
 * To add a new type:
 * 1. Add it here
 * 2. Add an entry in checkinTypeInfo below
 */
export enum PrivateCheckinType {
  SOCIAL_REASSURANCE = 'SOCIAL_REASSURANCE',
  NOT_ALONE = 'NOT_ALONE',
  INTEREST_BRIDGE = 'INTEREST_BRIDGE',
  TRANSCRIPT_HOOK = 'TRANSCRIPT_HOOK',
  NONE = 'NONE'
}

interface CheckinAnalysis {
  shouldIntervene: boolean
  checkinType: PrivateCheckinType
  reasoning: string
  directMessage?: string | null
  confidenceScore: number
  detectedPattern?: string | null
  sourceMessages?: { participant: string; text: string }[] | null
  context?: string
}

/**
 * Context passed to evaluateShared — available once before the participant loop.
 */
interface SharedCheckinContext {
  sharedChatHistory: ConversationHistory
  allDmHistory: ConversationHistory
  agentInstance: AgentLike
}

/**
 * Context passed to isEligible — available per participant.
 */
interface ParticipantCheckinContext {
  participantDmHistory: ConversationHistory
  participantPseudonym: string
  allDmHistory: ConversationHistory
  endTime: Date | undefined
  agentInstance: AgentLike
}

/**
 * Full definition for a check-in type.
 *
 * evaluateShared: optional, runs once before the participant loop. Return value is passed
 *   to isEligible as sharedResult. Use for expensive shared determinations (e.g. transcript
 *   density) that would otherwise be repeated per participant.
 *
 * isEligible: optional, runs per participant using the shared result. If it returns false,
 *   the type is excluded from that participant's prompt and schema, and the LLM call is
 *   skipped entirely if no types remain eligible.
 */
interface CheckinTypeDefinition {
  description: string
  register: string
  examples: string[]
  evaluateShared?: (context: SharedCheckinContext) => Promise<TranscriptDensityResult>
  isEligible?: (context: ParticipantCheckinContext, sharedResult: TranscriptDensityResult) => boolean
}

const transcriptDensitySchema = z.object({
  isDense: z.boolean().describe('Whether the transcript section was genuinely dense or fast-moving'),
  topic: z.string().nullable().describe('The specific topic that was dense, if isDense is true — null otherwise')
})

type TranscriptDensityResult = z.infer<typeof transcriptDensitySchema> | null

const checkinTypeInfo: Record<PrivateCheckinType, CheckinTypeDefinition> = {
  [PrivateCheckinType.SOCIAL_REASSURANCE]: {
    description: `Goal: acknowledge a recurring pattern of hesitation, self-doubt, or dissent in this participant's own messages, normalize it, and reduce pressure to perform or conform.

Only send when the same signal has appeared in at least 3 separate messages from this participant. A single message — no matter how hedged — does not qualify, because the Q&A response already addressed it. Do not use sourceMessages for this type — it is about the individual's own pattern, not cross-participant comparison. Look for accumulation across turns:

- Repeatedly apologizing for or minimizing their own contribution before making it ("sorry if this is obvious", "I'm probably wrong but", "not sure this is worth asking")
- Asking whether they're the only one feeling a certain way — checking if their reaction is legitimate
- Keeping their own experience at arm's length, talking about it as if it belongs to someone else ("some people might feel...", "I could imagine someone thinking...")
- Going quiet or pulling back after a moment of friction or pushback
- Stacking multiple qualifiers in a single message in a way that suggests the question almost didn't get sent`,
    register: 'Always warm',
    examples: [
      '(Repeated self-minimization) "The questions you keep almost not sending are usually the most worth asking."',
      '(Recurring dissent or skepticism) "Keeping a running doubt alive across a whole conversation usually means you\'re onto something. That\'s worth staying with."',
      '(Pulling back after friction) "If something landed sideways, you don\'t have to frame it as a question — one word is enough."',
      '(General pattern of hedging) "Nothing here requires certainty. Uncertainty usually means you\'re paying close attention."'
    ],
    isEligible: ({ participantDmHistory }) => participantDmHistory.messages.filter((m) => !m.fromAgent).length >= 3
  },
  [PrivateCheckinType.NOT_ALONE]: {
    description: `Goal: reduce isolation by letting this participant know others in the room are privately feeling the same doubt, hesitation, or uncertainty — without naming anyone or revealing specifics.

Only send when you have verified evidence in the private messages that at least one other participant is expressing the same sentiment. Populate sourceMessages with the specific messages that support the claim — these will be verified. Do not send without sourceMessages. This type can trigger on a single message from the target participant if the cross-participant signal is clear.

The message is entirely about solidarity — that their reaction is shared, not unique to them. Do not address their individual pattern here; use SOCIAL_REASSURANCE for that.`,
    register: 'Warm',
    examples: [
      '"A few others are privately sitting with similar questions — you\'re in good company."',
      '"You\'re not the only one circling that. Others are privately sitting with something similar, even if it\'s not coming up in the main chat."',
      '"That hesitation is more common in this room than you might think."'
    ],
    isEligible: ({ participantPseudonym, allDmHistory, participantDmHistory }) =>
      participantDmHistory.messages.some((m) => !m.fromAgent) &&
      allDmHistory.messages.some((m) => !m.fromAgent && m.pseudonym !== participantPseudonym)
  },
  [PrivateCheckinType.INTEREST_BRIDGE]: {
    description:
      'Let a participant know others are privately asking about the same topic — shared curiosity, not shared anxiety',
    register: 'Warm',
    examples: [
      '"A few people have been privately asking about [topic area] — seems like it\'s resonating beyond what\'s come up in the main chat."',
      '"You\'re not the only one thinking about [topic area]. There\'s more interest in that than the conversation has had space for."'
    ],
    isEligible: ({ participantPseudonym, allDmHistory, participantDmHistory }) =>
      participantDmHistory.messages.some((m) => !m.fromAgent) &&
      allDmHistory.messages.some((m) => !m.fromAgent && m.pseudonym !== participantPseudonym)
  },
  [PrivateCheckinType.TRANSCRIPT_HOOK]: {
    description:
      'After a dense or fast-moving section of the transcript, reach out to a participant who has been quiet — name the specific topic and offer to dig into any part of it. Removes the burden of question formation entirely. Only send if the transcript was genuinely dense or fast-moving AND the participant has been quiet recently. Always name a specific topic — never send a generic "things moved fast" message.',
    register: 'Warm, low-pressure',
    examples: [
      '"We just moved through a lot on [specific topic]. Happy to go deeper, make connections, or just sit with any part of it, no need to phrase it as a question."',
      '"That [topic] section moved fast. If anything in there didn\'t land, just point me at it — one word is enough."'
    ],
    evaluateShared: async ({ sharedChatHistory, agentInstance }) => {
      const windowSeconds = agentInstance.triggers?.periodic?.timerPeriod ?? 180
      const recentTranscript = transcript.getTranscript(agentInstance.conversation, windowSeconds, sharedChatHistory.end)
      if (!recentTranscript?.trim()) return { isDense: false, topic: null }

      try {
        const llm = await agentInstance.getLLM()
        return await getChatPromptResponse(
          llm,
          'You are evaluating whether a recent event transcript section was dense or fast-moving enough to warrant a check-in with participants who have been quiet. Dense means: multiple concepts delivered quickly, significant information density, or a pace that could leave people behind. Sparse means: introductory remarks, pauses, light content, or a slow pace.',
          'Recent transcript:\n{recentTranscript}\n\nWas this section genuinely dense or fast-moving? If yes, name the primary topic.',
          { recentTranscript },
          [],
          transcriptDensitySchema
        )
      } catch (err) {
        logger.warn(`[checkinHandler] transcript density evaluation failed: ${err}`)
        return { isDense: false, topic: null }
      }
    },
    isEligible: ({ participantDmHistory, endTime, agentInstance }, sharedResult) => {
      if (!sharedResult?.isDense) return false
      const windowMs = (agentInstance.triggers?.periodic?.timerPeriod ?? 180) * 1000
      const cutoff = endTime ? new Date(endTime.getTime() - windowMs) : new Date(0)
      return !participantDmHistory.messages.some((m) => !m.fromAgent && m.createdAt && m.createdAt > cutoff)
    }
  },
  [PrivateCheckinType.NONE]: {
    description: 'No message needed — silence is the right call',
    register: 'N/A',
    examples: []
  }
}

function getCheckinDmAnalysisSchema(eligibleTypes: PrivateCheckinType[]) {
  const checkinTypeStrings = [...eligibleTypes.map((t) => t.toString()), PrivateCheckinType.NONE.toString()] as unknown as [
    string,
    ...string[]
  ]
  return z.object({
    shouldIntervene: z.boolean().describe('Whether to send a check-in message'),
    checkinType: z.enum(checkinTypeStrings).describe('The type of check-in to send'),
    reasoning: z
      .string()
      .describe('Internal analysis of what signals you detected and why you are or are not sending a message'),
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
        'If your message implies others share this view or interest, provide the exact source messages here. Required whenever you reference shared sentiment or shared interest. Leave null if the message is only about this participant.'
      )
  })
}

const CHECKIN_USER_TEMPLATE = `## Event Topic:
{topic}

## You are writing to:
{participantPseudonym}

## This Participant's DM History:
{thisParticipantHistory}

## Recent Transcript (last 10 minutes):
{recentTranscript}

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

function buildCheckinSystemPrompt(eligibleTypes: PrivateCheckinType[]): string {
  const typeSections = eligibleTypes.map((t) => buildInterventionTypeSection(t, checkinTypeInfo[t])).join('\n\n')
  const transcriptNote = eligibleTypes.includes(PrivateCheckinType.TRANSCRIPT_HOOK)
    ? '\n- Recent transcript (last 10 minutes) — use this to identify the dense section for TRANSCRIPT_HOOK'
    : ''

  return `You are a supportive AI assistant at a live event, reaching out privately to individual participants when there is a meaningful reason to do so.

## Who you are writing to
You are composing a private message for the participant identified at the top of the prompt. The "Private Messages" section contains DMs from all participants — use the others only to understand shared patterns, never as content to surface directly.

## What you are looking at
- This participant's DM history — their own conversation with you, for direct reference
- Shared chat history — includes the participant's public activity
- Private messages (all participants) — use only to understand shared patterns${transcriptNote}

## Voice

Always warm. Never clinical, never over-affirming, never sycophantic. Neurodiversity-affirming: every question is worth asking; never imply otherwise. 1-3 sentences maximum.

## Rules

- Write only to the identified participant — the directMessage field is sent privately to them alone
- Never mention that you analyzed messages or used AI to detect patterns
- Never quote or closely paraphrase any participant's words
- Never name or hint at any other participant
- Before sending, check your recent posts: have you already said something similar to this participant? If so, choose NONE unless their situation has meaningfully evolved since then.
- Never repeat a theme unless something has genuinely changed — a new signal, a new message, a new pattern.
- Vary your check-in types.
- Silence is the default. Most cycles should produce no message.

## Check-in Types

${typeSections}`
}

/**
 * Main entry point called from eventAssistant.respond() when triggered periodically.
 * Iterates over each participant's DM channel and decides whether to send a check-in.
 * Called with `this` = agent instance.
 */
export async function buildCheckinResponses(conversationHistory: ConversationHistory) {
  // Participants may not be deep-populated when the conversation loads — populate them now so the
  // pseudonym fallback in formatDmHistoryByChannel has full user docs.
  const allDirect = this.conversation.channels.filter((c: IChannel) => c.direct)
  await Promise.all(
    allDirect.map((c) => (c as unknown as { populate(path: string): Promise<void> }).populate('participants'))
  )
  // Small chance there are duplicate direct channels with the same name due to React StrictMode double-invoking effects in development. De-dup just in case, to avoid duplicate messages.
  const directChannels: IChannel[] = Array.from(
    new Map<string, IChannel>(
      this.conversation.channels
        .filter(
          (channel: IChannel) =>
            channel.direct && channel.participants?.some((p) => p._id?.toString() === this._id.toString())
        )
        .map((channel: IChannel) => [channel.name, channel])
    ).values()
  )

  if (directChannels.length === 0) return []

  // Rate-limit pre-check: if every participant has been messaged recently, there is nothing
  // to do and we should skip shared evaluations (which include an LLM call for transcript density).
  const now = conversationHistory.end ? conversationHistory.end.getTime() : Date.now()
  const minInterval = (this.agentConfig?.minInterval ?? 10) * 60 * 1000

  // Use startTime as baseline for first checkin — resets on conversation restart, which is intentional.
  const conversationStart = new Date(this.conversation.startTime).getTime()
  const anyEligible = directChannels.some((channel) => {
    const lastAgentMsg = conversationHistory.messages
      .filter((m) => m.channels?.includes(channel.name) && m.fromAgent && m.visible)
      .at(-1)
    const baseline = lastAgentMsg ? new Date(lastAgentMsg.createdAt!).getTime() : conversationStart
    return now - baseline >= minInterval
  })

  if (!anyEligible) {
    logger.debug('CheckinHandler: all participants rate-limited — skipping shared evaluations')
    return []
  }

  const sharedChatHistory = getConversationHistory(conversationHistory.messages, {
    count: 100,
    channels: ['chat'],
    endTime: conversationHistory.end
  })

  // All DM history across all participant channels — passed as private context to each LLM call,
  // same as eventMediator. The LLM reasons about shared patterns across participants semantically.
  const allDmHistory = getConversationHistory(
    conversationHistory.messages,
    { count: 100, directMessages: true, endTime: conversationHistory.end },
    null,
    this.conversation.channels.filter((c: IChannel) => c.direct).map((c: IChannel) => c.name)
  )

  // Run shared evaluations once in parallel before the participant loop.
  // Types with evaluateShared perform expensive shared determinations (e.g. transcript density)
  // that would otherwise be repeated per participant.
  const activeTypes = Object.values(PrivateCheckinType).filter((t) => t !== PrivateCheckinType.NONE)
  const sharedContext: SharedCheckinContext = { sharedChatHistory, allDmHistory, agentInstance: this }
  const sharedResults: Partial<Record<PrivateCheckinType, TranscriptDensityResult>> = Object.fromEntries(
    await Promise.all(
      activeTypes
        .filter((t) => checkinTypeInfo[t].evaluateShared)
        .map(async (t) => [t, await checkinTypeInfo[t].evaluateShared!(sharedContext)])
    )
  )

  // Run per-participant LLM calls in parallel — each call is independent (rate limiting
  // is scoped to the individual participant's DM history, not shared state).
  const participantResults = await Promise.all(
    directChannels.map(async (channel) => {
      const channelMessages = conversationHistory.messages.filter((m) => m.channels?.includes(channel.name))

      // Resolve pseudonym from message history first; fall back to channel.participants for users
      // who haven't sent any DMs yet (e.g. TRANSCRIPT_HOOK targets quiet participants).
      const participantMessage = channelMessages.find((m) => !m.fromAgent)
      const participantPseudonym =
        participantMessage?.pseudonym ||
        channel.participants?.find((p) => p._id?.toString() !== this._id.toString())?.activePseudonym?.pseudonym ||
        'participant'

      const participantDmHistory = getConversationHistory(channelMessages, {
        count: 50,
        endTime: conversationHistory.end
      })

      const participantContext: ParticipantCheckinContext = {
        participantDmHistory,
        participantPseudonym,
        allDmHistory,
        endTime: conversationHistory.end ?? undefined,
        agentInstance: this
      }

      // Filter to types eligible for this participant. Types without isEligible always pass through.
      const eligibleTypes = activeTypes.filter((t) => {
        const { isEligible } = checkinTypeInfo[t]
        return !isEligible || isEligible(participantContext, sharedResults[t] ?? null)
      })

      if (eligibleTypes.length === 0) {
        logger.debug(`[checkinHandler] no eligible types for ${participantPseudonym} — skipping LLM call`)
        return null
      }

      const systemPrompt = buildCheckinSystemPrompt(eligibleTypes)
      const schema = getCheckinDmAnalysisSchema(eligibleTypes)

      const thisParticipantHistory =
        participantDmHistory.messages.length > 0
          ? formatDmHistoryByChannel(participantDmHistory.messages, [channel])
          : 'No messages yet from this participant.'

      // detectPrivateInterventionOpportunity handles rate limiting scoped to this participant's
      // DM channel via participantDmHistory. allDmHistory is passed as privateConversationHistory
      // so the LLM has full cross-participant context. The schema uses `directMessage` instead of
      // `sharedChatMessage`, so the professionalism check inside is skipped — appropriate here.
      const analysis = (await detectPrivateInterventionOpportunity.call(
        this,
        sharedChatHistory,
        systemPrompt,
        schema,
        allDmHistory,
        participantDmHistory,
        CHECKIN_USER_TEMPLATE,
        { participantPseudonym, thisParticipantHistory }
      )) as unknown as CheckinAnalysis | null

      if (!analysis?.directMessage) {
        logger.debug(
          `${this.agentType} ${this._id}: no intervention opportunity detected for participant ${participantPseudonym}`
        )
        return null
      }

      // If the message implies cross-participant patterns, verify cited participant+text pairs are real.
      // Mirrors backChannel hallucination filtering: the LLM must cite sources it can actually see.
      if (analysis.sourceMessages?.length) {
        const otherParticipantMessages = [...allDmHistory.messages, ...sharedChatHistory.messages].filter(
          (m) => !m.fromAgent && m.pseudonym !== participantPseudonym
        )
        if (!filterHallucinations(analysis.sourceMessages, otherParticipantMessages)) {
          logger.warn(
            `CheckinHandler: suppressed hallucinated cross-participant claim for ${participantPseudonym}: cited ${JSON.stringify(
              analysis.sourceMessages
            )}`
          )
          return null
        }
      }

      logger.info(
        `Checkin Handler: ${analysis.checkinType} → ${participantPseudonym} (${channel.name}): ${analysis.detectedPattern}`
      )
      return {
        visible: true,
        message: { type: 'checkin', text: analysis.directMessage },
        messageType: 'json',
        channels: [channel],
        context: analysis.context,
        participantPseudonym,
        eligibleTypes,
        checkinType: analysis.checkinType,
        reasoning: analysis.reasoning,
        confidenceScore: analysis.confidenceScore,
        detectedPattern: analysis.detectedPattern
      }
    })
  )

  return participantResults.filter(Boolean)
}
