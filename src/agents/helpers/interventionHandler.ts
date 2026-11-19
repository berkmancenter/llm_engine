import { z } from 'zod'
import { BehaviorPolicy, ConversationHistory, ConversationGoal, IChannel } from '../../types/index.types.js'
import { formatMultiUserConversationHistory, formatDmHistoryByChannel } from './llmInputFormatters.js'
import transcript from './transcript.js'
import { getChatPromptResponse, getAgentStructuredResponse, AgentToolCallTrace } from './llmChain.js'
import { getTools, buildToolsGuidance } from '../tools/registry.js'

import logger from '../../config/logger.js'
import { getConfidenceThreshold, getEffectiveMinConfidence, getMinContributionMs } from './promptComposer.js'

/**
 * Why a tick ended up sending nothing, for a traceOnly response to show alongside the model's own
 * `reasoning` (which only ever explains the model's read of the conversation, not which gate — if
 * any — went on to suppress it). The first two are set by runInterventionAnalysis itself; the rest
 * by proactiveGroupAgent/checkinHandler's trace-only response builders, for a suppression that
 * happens after this function already returned a real, above-threshold analysis.
 */
export type DeclineReason =
  | 'model_declined'
  | 'below_threshold'
  // A goal declared tools it needs (ConversationGoal.tools) but the agent loop never actually
  // invoked one this tick — generic across every tool-dependent goal, set by
  // runInterventionAnalysis itself rather than a goal-specific check in the calling agent.
  | 'tool_goal_ungrounded'
  | 'socratic_no_reading'
  | 'socratic_writer_failed'
  | 'professionalism_rejected'
  | 'message_missing'
  | 'poll_creation_failed'
  | 'no_direct_message'
  | 'hallucination_filtered'

/**
 * Analysis result from intervention detection — shared across proactiveGroupAgent and checkinHandler.
 */
export interface InterventionAnalysis {
  shouldIntervene: boolean
  goalId?: string
  reasoning: string
  sharedChatMessage?: string | null
  directMessage?: string | null
  confidenceScore: number
  detectedPattern?: string | null
  affectedUsers?: number | null
  sourceMessages?: { participant: string; text: string }[] | null
  context?: string
  /* The fields below exist so a traceOnly response (built by proactiveGroupAgent's
     buildTraceOnlyResponse / checkinHandler's buildTraceOnlyCheckinResponse) can show what was
     suppressed and why, instead of just the normalized "did nothing" shape. */
  // The goal/message the model actually proposed, captured here only when this below-threshold
  // check is what suppressed it — a later suppression (professionalism, missing message, ...)
  // reads goalId/sharedChatMessage/directMessage directly instead, since those are still intact.
  proposedGoalId?: string | null
  proposedMessage?: string | null
  // The effective threshold this confidenceScore was measured against, set only alongside
  // proposedGoalId/proposedMessage above.
  confidenceThreshold?: number
  declineReason?: DeclineReason | null
}

export const USER_TEMPLATE = `## Event Topic:
{topic}

## Recent Transcript:
{recentTranscript}

## Retrieved Relevant Context from Transcript:
{retrievedChunks}

## Private Messages (Direct Messages):
{privateMessages}

## Shared Chat History:
{sharedChatHistory}

## Your Recent Posts:
{agentRecentPosts}

---

Analyze the current state and determine if an intervention is warranted. Follow the decision framework and output valid JSON only.`

export const interventionLlmTemplateVars = {
  system: [],
  user: [
    { name: 'topic', description: 'The event topic' },
    { name: 'recentTranscript', description: 'Transcript from the event' },
    { name: 'retrievedChunks', description: 'Relevant retrieved context from RAG search' },
    { name: 'privateMessages', description: 'Private/direct messages from participants' },
    { name: 'sharedChatHistory', description: 'Shared chat history including agent posts' },
    { name: 'agentRecentPosts', description: "The agent's own recent posts for self-awareness" }
  ]
}
/**
 * Build the intervention type section for the system prompt.
 * Used by checkinHandler for PrivateCheckinType sections.
 */
export function buildInterventionTypeSection(interventionType, defaultInfo): string {
  if (interventionType === 'NONE') {
    return ''
  }

  const lines: string[] = [
    `### ${interventionType} — ${defaultInfo.description}`,
    `[${defaultInfo.register}]`,
    '',
    'Examples:'
  ]

  for (const example of defaultInfo.examples) {
    lines.push(`- ${example}`)
  }

  return lines.join('\n')
}

// Helper to extract agent's recent posts from conversation history
function getAgentRecentPosts(conversationHistory: ConversationHistory, agentName: string, count: number = 5): string {
  const agentPosts = conversationHistory.messages.filter((msg) => msg.pseudonym === agentName && msg.visible).slice(-count)

  if (agentPosts.length === 0) {
    return 'None yet - this would be your first intervention.'
  }

  return agentPosts
    .map((msg) => {
      const timestamp = msg.createdAt?.toISOString() || 'unknown'
      const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)
      return `[${timestamp}] ${body}`
    })
    .join('\n')
}

// Helper to check recent agent interventions for rate limiting. Checks for any agent intervention in the conversation
function getRecentAgentInterventions(conversationHistory: ConversationHistory): Array<{ timestamp: Date }> {
  return conversationHistory.messages
    .filter((msg) => msg.fromAgent && msg.visible)
    .map((msg) => ({ timestamp: msg.createdAt! }))
}

/**
 * Shared LLM evaluation core: formats histories, retrieves transcript/RAG context, calls the LLM,
 * checks confidence and professionalism, and attaches the trace context string.
 * Rate limiting is handled by the two public wrappers below.
 */
export async function runInterventionAnalysis(
  sharedChatHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  privateConversationHistory: ConversationHistory | null,
  userTemplate: string | undefined,
  extraTemplateVars?: Record<string, string>,
  activeGoals?: ConversationGoal[],
  behaviorPolicy?: BehaviorPolicy,
  channelType: 'dm' | 'groupChat' = 'groupChat',
  recentTranscript?: string,
  goalPriorities?: Record<string, number>,
  backgroundReading?: string
): Promise<InterventionAnalysis> {
  // Format conversation histories
  const sharedChatMessages = formatMultiUserConversationHistory(sharedChatHistory)

  // Format DM history grouped by channel so agent messages show their recipient.
  // This prevents the LLM from seeing 50 separately-addressed checkins as duplicates,
  // and from attributing another participant's conversation to the current participant.
  const dmChannels = this.conversation.channels.filter((c: IChannel) => c.direct)
  await Promise.all(
    dmChannels.map((c) => (c as unknown as { populate(path: string): Promise<void> }).populate('participants'))
  )
  const privateMessagesText = privateConversationHistory
    ? formatDmHistoryByChannel(privateConversationHistory.messages, dmChannels)
    : ''

  // Use caller-provided transcript if available; otherwise default to last 10 minutes
  const resolvedTranscript = recentTranscript ?? transcript.getTranscript(this.conversation, 600, sharedChatHistory.end)

  // Get relevant context via RAG - use both private and public messages to find relevant transcript chunks
  const allMessages = [...sharedChatMessages.map((m) => m.content), privateMessagesText].join('\n')
  const { chunks } = await transcript.searchTranscript(this.conversation, allMessages, sharedChatHistory.end)

  // Get agent's recent posts for self-awareness
  const agentRecentPosts = getAgentRecentPosts(sharedChatHistory, this.name, 5)

  const baseUserTemplate = userTemplate ?? this.llmTemplates.user ?? USER_TEMPLATE
  // Reading passages and ad hoc caller context ride in the user prompt (not the system prompt)
  // so the system prompt stays byte-stable for prompt caching. Each is prepended only when the
  // caller actually has one, so a caller with neither renders byte-identical to before either
  // existed.
  const resolvedUserTemplate =
    [
      backgroundReading && `## Background Reading:\n{backgroundReading}\n\n`,
      extraTemplateVars?.additionalContext && `## Additional Context:\n{additionalContext}\n\n`
    ]
      .filter(Boolean)
      .join('') + baseUserTemplate

  const templateVars = {
    topic: this.conversation.name,
    recentTranscript: resolvedTranscript,
    retrievedChunks: chunks,
    privateMessages: privateMessagesText || 'No private messages.',
    sharedChatHistory:
      sharedChatMessages.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content)).join('\n') ||
      'No shared chat messages yet.',
    agentRecentPosts,
    ...(backgroundReading ? { backgroundReading } : {}),
    ...extraTemplateVars
  }

  const renderedUserPrompt = Object.entries(templateVars).reduce(
    (prompt, [key, value]) =>
      // A string replacement here would let unsanitized chat text containing "$&", "$$", "$`" or
      // "$'" be interpreted as a replacement pattern (e.g. "$&" re-inserts the matched "{key}"
      // placeholder) rather than substituted literally. A replacer function's return value is
      // never pattern-interpreted, so this is the actual prompt sent to the model, not just a
      // trace field: it has to carry arbitrary participant text through unchanged.
      // eslint-disable-next-line security/detect-non-literal-regexp
      prompt.replace(new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), () => value ?? ''),
    resolvedUserTemplate
  )

  // A goal can declare named tools it needs to make its own decision (ConversationGoal.tools),
  // resolved generically via the shared tool registry — the same one communityAssistant and
  // eventAssistant already use — so goal-specific retrieval code never has to live in the
  // calling agent. Ticks where no active goal declares tools are completely unaffected: tools
  // stays empty and the plain, non-tool-calling call below runs exactly as it always has.
  const neededToolNames = [...new Set((activeGoals ?? []).flatMap((g) => g.tools ?? []))]
  const toolContext = { topicIds: this.agentConfig?.topicIds, activeConversationId: this.conversation?._id?.toString() }
  const tools = neededToolNames.length > 0 ? await getTools(neededToolNames, toolContext) : []
  let resolvedSystemPrompt = baseSystemPrompt
  if (tools.length > 0) {
    const toolsGuidance = await buildToolsGuidance(neededToolNames, toolContext)
    if (toolsGuidance) resolvedSystemPrompt = `${baseSystemPrompt}\n\n${toolsGuidance}`
  }

  const llm = await this.getLLM()
  const analysis = (
    tools.length > 0
      ? await getAgentStructuredResponse(llm, tools, resolvedSystemPrompt, renderedUserPrompt, schema, undefined, 20, {
          returnToolTrace: true
        })
      : await getChatPromptResponse(
          llm,
          resolvedSystemPrompt,
          resolvedUserTemplate,
          templateVars,
          [], // No chat history - we provide full context in the prompt
          schema
        )
  ) as z.infer<typeof schema> & { toolTrace?: AgentToolCallTrace }

  logger.debug(`Intervention opportunity analysis: ${JSON.stringify(analysis, null, 2)}`)

  // Below-threshold does NOT return null: the model already ran and its reasoning is real
  // information about why it declined, same as an explicit goalId: 'none' decision — discarding
  // it here (as this used to) meant a caller building a trace from the returned analysis could
  // never see it, even though it's visible on the LLM call's own span. goalId/sharedChatMessage/
  // directMessage are overridden to 'none'/null/null so this still reads as "don't intervene" to
  // either caller: proactiveGroupAgent branches on goalId/sharedChatMessage, checkinHandler
  // (via detectPrivateInterventionOpportunity, which just forwards this return value) branches
  // on directMessage alone — leaving it untouched would let a model-proposed directMessage
  // through even when shouldIntervene/confidence said not to.
  // Threshold is raised to 75 when socialSensitivity is 'high'.
  // Per-pattern minConfidence provides an additional floor applied per-call.
  const channelPolicy =
    channelType === 'dm'
      ? behaviorPolicy?.channels?.dm?.proactivePolicy
      : behaviorPolicy?.channels?.groupChat?.proactivePolicy
  const policyThreshold = getConfidenceThreshold(channelPolicy)
  const matchedGoal = activeGoals?.find((g) => g.id === analysis.goalId)
  const patternFloor = matchedGoal ? getEffectiveMinConfidence(matchedGoal, goalPriorities) : 0
  const effectiveThreshold = Math.max(policyThreshold, patternFloor)

  // A goal that declares tool dependencies can never be trusted ungrounded: if it was chosen but
  // the agent loop never actually invoked one of ITS OWN declared tools this tick (no topicIds
  // configured, a resolved tool returned nothing, the model called a different active goal's
  // tool instead, or it just didn't bother), treat it the same as a decline — generic across
  // every tool-dependent goal, so no goal-specific "did I actually retrieve something" check
  // needs to live in the calling agent. Checked against toolTrace.calls (which tool(s) were
  // actually invoked), not just .invoked (whether any tool was invoked by anyone this tick) —
  // two active goals can each declare a different tool, and the model choosing goal A is only
  // grounded if A's own tool ran, not merely because goal B's did.
  const invokedToolNames = new Set((analysis.toolTrace?.calls ?? []).map((call) => call.name))
  const ungroundedToolGoal = Boolean(
    matchedGoal?.tools?.length && !matchedGoal.tools.some((toolName) => invokedToolNames.has(toolName))
  )

  logger.debug(
    `[interventionHandler] goalId=${analysis.goalId} confidence=${analysis.confidenceScore} threshold=${effectiveThreshold} (policy=${policyThreshold}, patternFloor=${patternFloor})`
  )

  const result = analysis as InterventionAnalysis
  result.context = renderedUserPrompt

  if (!analysis.shouldIntervene || analysis.confidenceScore < effectiveThreshold || ungroundedToolGoal) {
    result.proposedGoalId = result.goalId ?? null
    result.proposedMessage = (channelType === 'dm' ? result.directMessage : result.sharedChatMessage) ?? null
    result.confidenceThreshold = effectiveThreshold
    result.declineReason = (() => {
      if (!result.shouldIntervene) return 'model_declined'
      if (ungroundedToolGoal) return 'tool_goal_ungrounded'
      return 'below_threshold'
    })()
    result.shouldIntervene = false
    result.goalId = 'none'
    result.sharedChatMessage = null
    result.directMessage = null
    return result
  }

  return result
}

/**
 * Detects whether to send a private check-in to an individual participant's DM channel.
 * Rate limiting is scoped to that participant's DM history. No DB race guard — private
 * DMs are handled by a single agent per conversation, so concurrent posting isn't a concern.
 * Used by checkinHandler.
 */
export async function detectPrivateInterventionOpportunity(
  sharedChatHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  allDmHistory: ConversationHistory,
  participantDmHistory: ConversationHistory,
  userTemplate?: string,
  extraTemplateVars?: Record<string, string>,
  activeGoals?: ConversationGoal[],
  behaviorPolicy?: BehaviorPolicy,
  recentTranscript?: string,
  goalPriorities?: Record<string, number>
): Promise<InterventionAnalysis | null> {
  const now = sharedChatHistory.end ? sharedChatHistory.end.getTime() : Date.now()
  const dmProactivePolicy = behaviorPolicy?.channels?.dm?.proactivePolicy
  const minInterval = getMinContributionMs(dmProactivePolicy, this.agentConfig)

  const lastIntervention = getRecentAgentInterventions(participantDmHistory).at(-1)
  // Use startTime as baseline for first intervention — resets on conversation restart, which is intentional.
  const baseline = lastIntervention ? lastIntervention.timestamp.getTime() : new Date(this.conversation.startTime).getTime()
  if (now - baseline < minInterval) {
    const secondsAgo = Math.round((now - baseline) / 1000)
    logger.debug(
      `${this.agentType} ${this._id}: rate limited for participant — last intervention ${secondsAgo}s ago (min ${
        minInterval / 1000
      }s)`
    )
    return null
  }

  return runInterventionAnalysis.call(
    this,
    sharedChatHistory,
    baseSystemPrompt,
    schema,
    allDmHistory,
    userTemplate,
    extraTemplateVars,
    activeGoals,
    behaviorPolicy,
    'dm',
    recentTranscript,
    goalPriorities
  )
}
