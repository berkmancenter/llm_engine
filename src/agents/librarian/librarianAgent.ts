import { z } from 'zod'
import logger from '../../config/logger.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import verify from '../helpers/verify.js'
import { searchLibraryTool } from '../tools/searchHarvardLibrary.js'

const recommendationSchema = z.object({
  recommendations: z
    .array(
      z.object({
        title: z.string(),
        authors: z.array(z.string()),
        year: z.number().optional(),
        abstract: z.string().optional(),
        relevanceReason: z.string().describe('One sentence explaining why this is relevant')
      })
    )
    .length(3)
    .describe('Exactly 3 reading recommendations')
})

/**
 *
 * This function queries the conversation history to find recent recommendations,
 * making it stateless and safe for use in clustered environments.
 *
 * @param conversationHistory - The conversation history to search
 * @param agentName - Name of the agent to filter by
 * @param maxAgeMinutes - Maximum age of recommendations to consider (default 30 minutes)
 * @returns Array of titles that were recently recommended
 */
function getRecentRecommendations(
  conversationHistory: ConversationHistory,
  agentName: string,
  maxAgeMinutes: number = 30
): string[] {
  const cutoffTime = conversationHistory.end
    ? conversationHistory.end.getTime() - maxAgeMinutes * 60 * 1000
    : Date.now() - maxAgeMinutes * 60 * 1000

  const recentMessages = conversationHistory.messages.filter(
    (msg) =>
      msg.pseudonym === agentName &&
      msg.fromAgent &&
      msg.visible &&
      msg.bodyType === 'json' &&
      msg.createdAt &&
      msg.createdAt.getTime() > cutoffTime
  )

  // Extract titles from message bodies
  const titles: string[] = []
  for (const msg of recentMessages) {
    try {
      const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body
      if (body && typeof body === 'object' && 'recommendations' in body && Array.isArray(body.recommendations)) {
        titles.push(
          ...body.recommendations
            .filter((r: unknown) => r && typeof r === 'object' && 'title' in r)
            .map((r: { title: unknown }) => String(r.title))
        )
      }
    } catch {
      // Skip malformed messages
    }
  }

  return titles
}

const buildPrompt = (
  conversationName: string,
  speakerNames: string,
  moderatorNames: string,
  transcript: string,
  recentRecsText: string
): string => {
  const lines = [
    'You are a research librarian helping participants in an academic event discover relevant readings.',
    '',
    `Event: ${conversationName}`,
    `Speakers: ${speakerNames}`,
    `Moderators: ${moderatorNames}`,
    '',
    'Recent discussion transcript (last 10 minutes):',
    transcript,
    '',
    'Use the search_harvard_library tool to find exactly 3 highly relevant academic resources from Harvard Library.',
    '',
    'Guidelines:',
    '- Search for key topics/themes from the discussion (use keyword= or subject= parameters)',
    '- Consider works BY the speakers/moderators (use author= parameter for author searches)',
    '- Aim for diverse, complementary recommendations',
    `- Avoid these recently recommended items: ${recentRecsText}`,
    '',
    'Provide exactly 3 recommendations with their relevance reasons.'
  ]
  return lines.join('\n')
}

export default verify({
  name: 'Librarian Agent',
  description: 'Suggests relevant academic readings based on event content',
  priority: 50,
  maxTokens: 8000, // Increased for text-based tool emulation which includes all tool calls/responses in output
  defaultTriggers: {
    periodic: {
      timerPeriod: 600, // 10 minutes
      conversationHistorySettings: {
        channels: ['transcript']
      }
    }
  },
  agentConfig: {
    maxRecommendations: 3,
    deduplicationWindowMinutes: 30,
    minTranscriptLength: 100,
    maxToolIterations: 3
  },
  llmTemplateVars: { system: [], user: [] }, // Not using templates - building prompt directly
  defaultLLMTemplates: { system: '', user: '' },
  defaultLLMPlatform,
  defaultLLMModel,
  defaultLLMModelOptions: {
    maxTokens: 8000 // Match maxTokens above for text-based tool emulation (LangChain format)
  },
  ragCollectionName: undefined,

  async initialize() {
    return true
  },

  async evaluate(userMessage?: IMessage) {
    return {
      action: AgentMessageActions.CONTRIBUTE,
      userMessage,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond(conversationHistory: ConversationHistory) {
    const transcript = formatTranscript(conversationHistory.messages)

    if (transcript.length < this.agentConfig.minTranscriptLength) {
      logger.debug('Transcript too short, skipping recommendations')
      return []
    }

    const llm = await this.getLLM()

    // 1. Get context
    const speakerNames = this.conversation.presenters?.map((p: { name: string }) => p.name).join(', ') || 'None'
    const moderatorNames = this.conversation.moderators?.map((m: { name: string }) => m.name).join(', ') || 'None'

    // 2. Get recent recommendations from conversation history
    // Need to get full conversation history, not just transcript window
    const fullHistory: ConversationHistory = {
      start: new Date(Date.now() - this.agentConfig.deduplicationWindowMinutes * 60 * 1000),
      end: conversationHistory.end,
      messages: this.conversation.messages // Access all messages
    }
    const recentRecs = getRecentRecommendations(fullHistory, this.name, this.agentConfig.deduplicationWindowMinutes)
    const recentRecsText = recentRecs.length > 0 ? recentRecs.join('; ') : 'None yet'

    // 3. Build prompt
    const promptText = buildPrompt(this.conversation.name, speakerNames, moderatorNames, transcript, recentRecsText)

    // 4. Invoke agent with structured output
    let result
    try {
      result = await getAgentStructuredResponse(
        llm,
        [searchLibraryTool],
        promptText,
        'Please provide 3 reading recommendations based on the discussion.',
        recommendationSchema
      )

      logger.debug(`Librarian Agent Result: ${JSON.stringify(result, null, 2)}`)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`Agent execution failed: ${errorMsg}`)
      return []
    }

    // 5. Return formatted response
    const resourcesChannel = this.conversation.channels.find((c: { name: string }) => c.name === 'resources')
    if (!resourcesChannel) {
      logger.warn('No resources channel found')
      return []
    }

    return [
      {
        visible: true,
        message: { content: result.recommendations, type: 'reading' },
        messageType: 'json',
        channels: [resourcesChannel]
      }
    ]
  },

  async start() {
    return true
  },

  async stop() {
    // No cleanup needed - using conversation history instead of in-memory state
    return true
  }
})
