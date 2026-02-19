import { z } from 'zod'
import { ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from '../helpers/llmInputFormatters.js'
import transcript from '../helpers/transcript.js'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { buildSystemPromptWithPersonality, getInterventionExamples } from './agentPersonality.js'
import { InterventionType, type InterventionAnalysis } from './interventionTypes.js'
import config from '../../config/config.js'
import logger from '../../config/logger.js'

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

## Moderator Context:
{moderatorContext}

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
    { name: 'moderatorContext', description: 'Communications with/from moderator' },
    { name: 'agentRecentPosts', description: "The agent's own recent posts for self-awareness" }
  ]
}
/**
 * Generate schema based on enabled intervention types
 * @param enabledInterventions - List of enabled intervention types (from getEnabledInterventions)
 * @param supportsModerator - Whether moderator escalation is supported
 */
export function getInterventionAnalysisSchema(enabledInterventions: InterventionType[], supportsModerator: boolean) {
  const interventionTypeStrings = enabledInterventions.map((t) => t.toString())

  const baseSchema = {
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
  }

  // Only include moderatorMessage field if moderator support is enabled
  if (supportsModerator) {
    return z.object({
      ...baseSchema,
      moderatorMessage: z
        .string()
        .nullable()
        .optional()
        .describe('Optional message to forward to moderator with context and suggested question')
    })
  }

  return z.object(baseSchema)
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

// Helper to check recent agent interventions for rate limiting
function getRecentAgentInterventions(
  conversationHistory: ConversationHistory,
  agentName: string
): Array<{ timestamp: Date }> {
  return conversationHistory.messages
    .filter((msg) => msg.pseudonym === agentName && msg.visible)
    .map((msg) => ({ timestamp: msg.createdAt! }))
}

/**
 * Main intervention detection function
 * @param conversationHistory - Shared chat history
 * @param privateConversationHistory - Private/DM history (can be null if not needed based on category config)
 * @param moderatorConversationHistory - Moderator channel history
 * @param categoryConfig - Optional category configuration (defaults to all enabled)
 */
export async function detectInterventionOpportunity(
  conversationHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  privateConversationHistory?: ConversationHistory | null,
  moderatorConversationHistory?: ConversationHistory
): Promise<InterventionAnalysis | null> {
  // Use conversationHistory.end as "now" to maintain consistent time simulation
  // This allows tests and the system to reason about specific moments in time
  const now = conversationHistory.end ? conversationHistory.end.getTime() : Date.now()
  const minInterval = this.agentConfig?.minInterval || 120000 // 1 min default

  // Get recent interventions from conversation history (stateless rate limiting)
  const recentInterventions = getRecentAgentInterventions(conversationHistory, this.name)

  // Rate limiting: Check if we intervened recently
  const lastIntervention = recentInterventions[recentInterventions.length - 1]
  if (lastIntervention) {
    const timeSinceLastIntervention = now - lastIntervention.timestamp.getTime()
    if (timeSinceLastIntervention < minInterval) {
      return null // Too soon since last intervention
    }
  }

  // Determine if this agent supports moderator escalation based on available channels
  const hasModeratorChannel = this.conversation.channels.some((c: { name: string }) => c.name === 'moderator')

  // Format conversation histories
  const sharedChatMessages = formatMultiUserConversationHistory(conversationHistory)
  const privateMessages = privateConversationHistory ? formatMultiUserConversationHistory(privateConversationHistory) : []
  const moderatorMessages = moderatorConversationHistory
    ? formatMultiUserConversationHistory(moderatorConversationHistory)
    : []

  // Get recent transcript (last 10 minutes)
  const recentTranscript = transcript.getTranscript(this.conversation, 600, conversationHistory.end)

  // Get relevant context via RAG - use both private and public messages to find relevant transcript chunks
  const allMessages = [...sharedChatMessages, ...privateMessages].map((m) => m.content).join('\n')
  const { chunks } = await transcript.searchTranscript(this.conversation, allMessages, conversationHistory.end)

  // Get agent's recent posts for self-awareness
  const agentRecentPosts = getAgentRecentPosts(conversationHistory, this.name, 5)

  // Determine which personality to use (if any)
  let personalityName: string | null = null
  if (this.agentConfig?.personality !== undefined) {
    personalityName = this.agentConfig.personality
  } else if (config.enableAgentPersonality) {
    personalityName = 'sarcastic-expert'
  }

  const systemPrompt = buildSystemPromptWithPersonality(baseSystemPrompt, personalityName)

  const userTemplate = this.llmTemplates.user || USER_TEMPLATE

  // Call LLM with structured output
  const llm = await this.getLLM()
  const analysis = (await getChatPromptResponse(
    llm,
    systemPrompt,
    userTemplate,
    {
      topic: this.conversation.name,
      recentTranscript,
      retrievedChunks: chunks,
      privateMessages: privateMessages.map((m) => m.content).join('\n') || 'No private messages.',
      sharedChatHistory: sharedChatMessages.map((m) => m.content).join('\n') || 'No shared chat messages yet.',
      moderatorContext: moderatorMessages.map((m) => m.content).join('\n') || 'No moderator communications.',
      agentRecentPosts
    },
    [], // No chat history - we provide full context in the prompt
    schema
  )) as z.infer<typeof schema>

  logger.debug(`Intervention opportunity analysis: ${JSON.stringify(analysis, null, 2)}`)

  // Validate that MODERATOR_ESCALATION is not used when moderator channel is not available
  if (analysis.interventionType === 'MODERATOR_ESCALATION' && !hasModeratorChannel) {
    logger.warn(
      `Agent ${this.name} attempted MODERATOR_ESCALATION without moderator channel support. Rejecting intervention.`
    )
    return null
  }

  // Return null if shouldn't intervene or confidence too low
  if (!analysis.shouldIntervene || analysis.confidenceScore < 60) {
    return null
  }

  return analysis as InterventionAnalysis
}
