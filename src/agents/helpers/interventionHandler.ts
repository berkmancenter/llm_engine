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
  userTemplate: string | undefined
): Promise<InterventionAnalysis | null> {
  // Format conversation histories
  const sharedChatMessages = formatMultiUserConversationHistory(sharedChatHistory)

  // Format DM history grouped by channel so agent messages show their recipient.
  // This prevents the LLM from seeing 50 separately-addressed checkins as duplicates,
  // and from attributing another participant's conversation to the current participant.
  const dmChannelNames = this.conversation.channels
    .filter((c: IChannel) => c.direct)
    .map((c: IChannel) => c.name)
  const privateMessagesText = privateConversationHistory
    ? formatDmHistoryByChannel(privateConversationHistory.messages, dmChannelNames)
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
      sharedChatMessages
        .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
        .join('\n') || 'No shared chat messages yet.',
    agentRecentPosts
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
  result.context = [`## System Prompt:\n${systemPrompt}`, `## User Prompt:\n${renderedUserPrompt}`].join('\n\n')

  return result
}

/**
 * Detects whether to post a public intervention to the shared chat channel.
 * Rate limiting and the DB race guard are both scoped to the shared chat.
 * Used by eventMediator and engagementAgent.
 */
export async function detectPublicInterventionOpportunity(
  sharedChatHistory: ConversationHistory,
  baseSystemPrompt: string,
  schema: z.ZodSchema,
  privateConversationHistory?: ConversationHistory | null,
  userTemplate?: string
): Promise<InterventionAnalysis | null> {
  const now = sharedChatHistory.end ? sharedChatHistory.end.getTime() : Date.now()
  const minInterval = (this.agentConfig?.minInterval || 2) * 60 * 1000

  const lastIntervention = getRecentAgentInterventions(sharedChatHistory).at(-1)
  if (lastIntervention && now - lastIntervention.timestamp.getTime() < minInterval) {
    return null
  }

  const result = await runInterventionAnalysis.call(
    this,
    sharedChatHistory,
    baseSystemPrompt,
    schema,
    privateConversationHistory ?? null,
    userTemplate
  )
  if (!result) return null

  const freshRecentIntervention = await Message.findOne({
    conversation: this.conversation._id,
    fromAgent: true,
    visible: true,
    channels: 'chat',
    createdAt: { $gte: new Date(now - minInterval) }
  })
  if (freshRecentIntervention) {
    logger.info(`Agent ${this.name} dropping intervention: another agent posted during LLM call`)
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
  userTemplate?: string
): Promise<InterventionAnalysis | null> {
  const now = sharedChatHistory.end ? sharedChatHistory.end.getTime() : Date.now()
  const minInterval = (this.agentConfig?.minInterval || 2) * 60 * 1000

  const lastIntervention = getRecentAgentInterventions(participantDmHistory).at(-1)
  if (lastIntervention && now - lastIntervention.timestamp.getTime() < minInterval) {
    return null
  }

  return runInterventionAnalysis.call(this, sharedChatHistory, baseSystemPrompt, schema, allDmHistory, userTemplate)
}
