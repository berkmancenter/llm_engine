import { z } from 'zod'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { BehaviorPolicy, ConversationHistory, ConversationGoal, IChannel } from '../../types/index.types.js'
import { formatMultiUserConversationHistory, formatDmHistoryByChannel } from './llmInputFormatters.js'
import transcript from './transcript.js'
import { getChatPromptResponse, getAgentStructuredResponse } from './llmChain.js'

import logger from '../../config/logger.js'
import { getConfidenceThreshold, getMinContributionMs } from './promptComposer.js'

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
}

export const USER_TEMPLATE = `## Event Topic:
{topic}

## Recent Transcript (last 10 minutes):
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
    { name: 'recentTranscript', description: 'Recent transcript from the event (last 10 minutes)' },
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
  tools?: StructuredToolInterface[]
): Promise<InterventionAnalysis | null> {
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

  const resolvedUserTemplate = userTemplate ?? this.llmTemplates.user ?? USER_TEMPLATE

  const templateVars = {
    topic: this.conversation.name,
    recentTranscript: resolvedTranscript,
    retrievedChunks: chunks,
    privateMessages: privateMessagesText || 'No private messages.',
    sharedChatHistory:
      sharedChatMessages.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content)).join('\n') ||
      'No shared chat messages yet.',
    agentRecentPosts,
    ...extraTemplateVars
  }

  const renderedUserPrompt = Object.entries(templateVars).reduce(
    (prompt, [key, value]) =>
      // eslint-disable-next-line security/detect-non-literal-regexp
      prompt.replace(new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), () => value ?? ''),
    resolvedUserTemplate
  )

  const llm = await this.getLLM()
  const analysis = (
    tools && tools.length > 0
      ? await getAgentStructuredResponse(llm, tools, baseSystemPrompt, renderedUserPrompt, schema)
      : await getChatPromptResponse(
          llm,
          baseSystemPrompt,
          resolvedUserTemplate,
          templateVars,
          [], // No chat history - we provide full context in the prompt
          schema
        )
  ) as z.infer<typeof schema>

  logger.debug(`Intervention opportunity analysis: ${JSON.stringify(analysis, null, 2)}`)

  // Return null if shouldn't intervene or confidence too low.
  // Threshold is raised to 75 when socialSensitivity is 'high'.
  // Per-pattern minConfidence provides an additional floor applied per-call.
  const channelPolicy = channelType === 'dm' ? behaviorPolicy?.channels?.dm?.proactivePolicy : behaviorPolicy?.channels?.groupChat?.proactivePolicy
  const policyThreshold = getConfidenceThreshold(channelPolicy)
  const matchedGoal = activeGoals?.find((g) => g.id === analysis.goalId)
  const patternFloor = matchedGoal?.triggers.minConfidence ?? 0
  const effectiveThreshold = Math.max(policyThreshold, patternFloor)

  logger.debug(`[interventionHandler] goalId=${analysis.goalId} confidence=${analysis.confidenceScore} threshold=${effectiveThreshold} (policy=${policyThreshold}, patternFloor=${patternFloor})`)

  if (!analysis.shouldIntervene || analysis.confidenceScore < effectiveThreshold) {
    return null
  }

  const result = analysis as InterventionAnalysis
  result.context = renderedUserPrompt

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
  tools?: StructuredToolInterface[]
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
    tools
  )
}
