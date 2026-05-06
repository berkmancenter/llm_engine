import { z } from 'zod'
import { ConversationHistory } from '../../types/index.types.js'
import { formatMultiUserConversationHistory } from './llmInputFormatters.js'
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
 * Main intervention detection function
 * @param conversationHistory - Shared chat history
 * @param privateConversationHistory - Private/DM history (can be null if not needed based on category config)
 * @param categoryConfig - Optional category configuration (defaults to all enabled)
 */
export async function detectInterventionOpportunity(
  conversationHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  privateConversationHistory?: ConversationHistory | null,
  sharedChatChannel: string = 'chat'
): Promise<InterventionAnalysis | null> {
  // Use conversationHistory.end as "now" to maintain consistent time simulation
  // This allows tests and the system to reason about specific moments in time
  const now = conversationHistory.end ? conversationHistory.end.getTime() : Date.now()
  const minInterval = (this.agentConfig?.minInterval || 2) * 60 * 1000 // Convert minutes to milliseconds
  // Get recent interventions from conversation history (stateless rate limiting)
  const recentInterventions = getRecentAgentInterventions(conversationHistory)

  // LLM-as-a-judge: Check if agent is monopolizing conversation or chilling human participation
  if (recentInterventions.length > 0) {
    const recentWindowMs = 10 * 60 * 1000 // 10 minutes
    const windowStart = now - recentWindowMs
    const recentMessages = conversationHistory.messages.filter(
      (msg) => msg.visible && msg.createdAt && msg.createdAt.getTime() >= windowStart
    )
    const totalRecentMessages = recentMessages.length
    const agentRecentMessages = recentMessages.filter((msg) => msg.fromAgent).length
    const humanRecentMessages = totalRecentMessages - agentRecentMessages

    if (totalRecentMessages > 0) {
      const agentSharePct = (agentRecentMessages / totalRecentMessages) * 100

      // Quick heuristic pre-check before calling LLM
      const likelyMonopolizing = agentSharePct > 40 || (humanRecentMessages < 3 && agentRecentMessages >= 2)

      if (likelyMonopolizing) {
        const llm = await this.getLLM()
        const monitorSchema = z.object({
          isMonopolizing: z.boolean(),
          reasoning: z.string()
        })

        const recentMessagesFormatted = recentMessages
          .map((msg) => {
            const speaker = msg.fromAgent ? `[AGENT: ${msg.pseudonym}]` : `[HUMAN: ${msg.pseudonym}]`
            const body = typeof msg.body === 'string' ? msg.body : JSON.stringify(msg.body)
            return `${speaker}: ${body}`
          })
          .join('\n')

        const monopolizationAnalysis = (await getChatPromptResponse(
          llm,
          `You are evaluating whether an AI agent is negatively impacting human conversation participation.
Assess if the agent is monopolizing the discussion or creating a chilling effect that makes humans hesitant to post.
Signs include: high agent message ratio, declining human participation after agent posts, humans not following up on their own threads, or conversations becoming agent-to-agent/agent monologue patterns.
Output valid JSON only.`,
          `## Recent conversation (last 10 minutes):
{recentMessages}

## Stats:
- Total messages: {totalMessages}
- Agent messages: {agentMessages} ({agentSharePct}% of conversation)
- Human messages: {humanMessages}

Is the agent monopolizing the conversation or creating a chilling effect on human participation?`,
          {
            recentMessages: recentMessagesFormatted,
            totalMessages: String(totalRecentMessages),
            agentMessages: String(agentRecentMessages),
            agentSharePct: agentSharePct.toFixed(1),
            humanMessages: String(humanRecentMessages)
          },
          [],
          monitorSchema
        )) as z.infer<typeof monitorSchema>

        if (monopolizationAnalysis.isMonopolizing) {
          logger.warn(
            `Agent ${this.name} suppressing intervention — monopolization detected: ${monopolizationAnalysis.reasoning}`
          )
          return null
        }
      }
    }
  }

  // Rate limiting: Check if an agent intervened recently
  const lastIntervention = recentInterventions[recentInterventions.length - 1]
  if (lastIntervention) {
    const timeSinceLastIntervention = now - lastIntervention.timestamp.getTime()
    if (timeSinceLastIntervention < minInterval) {
      return null // Too soon since last intervention
    }
  }

  // Format conversation histories
  const sharedChatMessages = formatMultiUserConversationHistory(conversationHistory)
  const privateMessages = privateConversationHistory ? formatMultiUserConversationHistory(privateConversationHistory) : []

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
      agentRecentPosts
    },
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

  // Re-check with fresh DB state to handle concurrent agents in a cluster.
  // Shrinks the race window from LLM latency (seconds) to milliseconds.
  const freshRecentIntervention = await Message.findOne({
    conversation: this.conversation._id,
    fromAgent: true,
    visible: true,
    channels: sharedChatChannel,
    createdAt: { $gte: new Date(now - minInterval) }
  })

  if (freshRecentIntervention) {
    logger.info(`Agent ${this.name} dropping intervention: another agent posted during LLM call`)
    return null
  }

  return analysis as InterventionAnalysis
}
