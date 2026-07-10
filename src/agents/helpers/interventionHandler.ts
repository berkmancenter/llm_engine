import { z } from 'zod'
import { ConversationHistory, IChannel } from '../../types/index.types.js'
import { formatMultiUserConversationHistory, formatDmHistoryByChannel } from './llmInputFormatters.js'
import transcript from './transcript.js'
import { getChatPromptResponse } from './llmChain.js'

import config from '../../config/config.js'
import logger from '../../config/logger.js'
import Message from '../../models/message.model.js'
import { InterventionAnalysis, InterventionType } from './interventionTypes.js'
import { buildSystemPromptWithPersonality, getInterventionExamples } from './agentPersonality.js'
import validateProfessionalism from './professionalismValidator.js'

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
 * Generate schema based on enabled intervention types
 * @param enabledInterventions - List of enabled intervention types (from getEnabledInterventions)
 */
export function getInterventionAnalysisSchema(enabledInterventions: InterventionType[]) {
  const interventionTypeStrings = enabledInterventions.map((t) => t.toString())

  return z.object({
    shouldIntervene: z.boolean().describe('Whether an intervention is warranted at this moment'),
    interventionType: z.enum(interventionTypeStrings as [string, ...string[]]).describe('The type of intervention to make'),
    reasoning: z.string().describe('Internal analysis of what patterns you see and why you are or are not intervening'),
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

/**
 * Build the intervention type section for the system prompt
 */
export function buildInterventionTypeSection(interventionType, defaultInfo, personalityName?): string {
  if (interventionType === InterventionType.NONE) {
    return '' // NONE doesn't get a section
  }

  // Try to get personality-specific examples
  const personalityExamples = getInterventionExamples(interventionType, personalityName)
  const examples = personalityExamples || defaultInfo.examples

  const lines: string[] = [
    `### ${interventionType} — ${defaultInfo.description}`,
    `[${defaultInfo.register}]`,
    '',
    'Examples:'
  ]

  for (const example of examples) {
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
 * Rate limiting and DB race guard are handled by the two public wrappers below.
 */
async function runInterventionAnalysis(
  sharedChatHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  privateConversationHistory: ConversationHistory | null,
  userTemplate: string | undefined,
  extraTemplateVars?: Record<string, string>
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

  // Get recent transcript (last 10 minutes)
  const recentTranscript = transcript.getTranscript(this.conversation, 600, sharedChatHistory.end)

  // Get relevant context via RAG - use both private and public messages to find relevant transcript chunks
  const allMessages = [...sharedChatMessages.map((m) => m.content), privateMessagesText].join('\n')
  const { chunks } = await transcript.searchTranscript(this.conversation, allMessages, sharedChatHistory.end)

  // Get agent's recent posts for self-awareness
  const agentRecentPosts = getAgentRecentPosts(sharedChatHistory, this.name, 5)

  // Determine which personality to use (if any)
  let personalityName: string | null = null
  if (this.agentConfig?.personality !== undefined) {
    personalityName = this.agentConfig.personality
  } else if (config.enableAgentPersonality) {
    personalityName = 'sarcastic-expert'
  }

  const systemPrompt = buildSystemPromptWithPersonality(baseSystemPrompt, personalityName)
  const resolvedUserTemplate = userTemplate ?? this.llmTemplates.user ?? USER_TEMPLATE

  const templateVars = {
    topic: this.conversation.name,
    recentTranscript,
    retrievedChunks: chunks,
    privateMessages: privateMessagesText || 'No private messages.',
    sharedChatHistory:
      sharedChatMessages.map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content)).join('\n') ||
      'No shared chat messages yet.',
    agentRecentPosts,
    ...extraTemplateVars
  }

  const llm = await this.getLLM()
  const analysis = (await getChatPromptResponse(
    llm,
    systemPrompt,
    resolvedUserTemplate,
    templateVars,
    [], // No chat history - we provide full context in the prompt
    schema
  )) as z.infer<typeof schema>

  logger.debug(`Intervention opportunity analysis: ${JSON.stringify(analysis, null, 2)}`)

  // Return null if shouldn't intervene or confidence too low
  if (!analysis.shouldIntervene || analysis.confidenceScore < 60) {
    return null
  }

  // Professionalism validation - check if message maintains appropriate professional boundaries
  if (analysis.sharedChatMessage) {
    const isAppropriate = await validateProfessionalism(
      llm,
      analysis.sharedChatMessage,
      this.conversation.name,
      analysis.interventionType,
      recentTranscript
    )
    if (!isAppropriate) {
      logger.warn(
        `Agent ${this.name} intervention rejected by professionalism guardrail. Type: ${analysis.interventionType}`
      )
      return null
    }
  }

  const renderedUserPrompt = Object.entries(templateVars).reduce(
    (prompt, [key, value]) =>
      // eslint-disable-next-line security/detect-non-literal-regexp
      prompt.replace(new RegExp(`\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g'), value ?? ''),
    resolvedUserTemplate
  )

  const result = analysis as InterventionAnalysis
  result.context = renderedUserPrompt

  return result
}

const PUBLIC_INTERVENTION_RULES = `
When weighing recent agent activity in Shared Chat History, distinguish between agents answering direct participant questions and agents making facilitative contributions — only the latter should count against intervening now.`

const RACE_GUARD_WINDOW_MS = 60 * 1000

/**
 * Returns true if a proactive agent intervention was posted to chat within the race guard window.
 * Exported for testing.
 */
export async function proactiveRaceGuard(conversationId, now = Date.now()): Promise<boolean> {
  const fresh = await Message.findOne({
    conversation: conversationId,
    'source.proactive': true,
    visible: true,
    channels: 'chat',
    createdAt: { $gte: new Date(now - RACE_GUARD_WINDOW_MS) }
  })
  return !!fresh
}

/**
 * Detects whether to post a public intervention to the shared chat channel.
 * The LLM decides on every invocation whether intervention is appropriate — no rate limiting.
 * A post-LLM DB race guard prevents two proactive agents from double-posting when both
 * evaluate concurrently. Only proactive messages are considered (not Q&A agents).
 */
export async function detectPublicInterventionOpportunity(
  sharedChatHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  privateConversationHistory?: ConversationHistory | null,
  userTemplate?: string
): Promise<InterventionAnalysis | null> {
  const now = sharedChatHistory.end ? sharedChatHistory.end.getTime() : Date.now()

  const result = await runInterventionAnalysis.call(
    this,
    sharedChatHistory,
    baseSystemPrompt + PUBLIC_INTERVENTION_RULES,
    schema,
    privateConversationHistory ?? null,
    userTemplate
  )
  if (!result) return null

  if (await proactiveRaceGuard(this.conversation._id, now)) {
    logger.info(`Agent ${this.name} dropping intervention: another proactive agent posted during LLM call`)
    return null
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
  extraTemplateVars?: Record<string, string>
): Promise<InterventionAnalysis | null> {
  const now = sharedChatHistory.end ? sharedChatHistory.end.getTime() : Date.now()
  const minInterval = (this.agentConfig?.minInterval ?? 2) * 60 * 1000

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
    extraTemplateVars
  )
}
