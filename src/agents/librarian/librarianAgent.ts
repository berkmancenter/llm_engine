import { z } from 'zod'
import logger from '../../config/logger.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import verify from '../helpers/verify.js'
import {
  getSemanticScholarRecommendationsTool,
  searchSemanticScholarTool
} from '../tools/semanticScholar.js'

const buildRecommendationSchema = (count: number) =>
  z.object({
    recommendations: z
      .array(
        z.object({
          title: z.string(),
          authors: z.array(z.string()),
          year: z.number().optional(),
          citationCount: z.number().describe('Citation count from search results'),
          publicationTypes: z.array(z.string()).describe('Publication types from search results'),
          url: z.string().optional().describe('URL from search results — include whenever one is returned by the tools'),
          relevanceReason: z.string().describe('One sentence explaining why this is relevant')
        })
      )
      .length(count)
      .describe(`Exactly ${count} reading recommendations`)
  })

/**
 *
 * This function queries the conversation history to find all previous recommendations,
 * making it stateless and safe for use in clustered environments.
 *
 * @param conversationHistory - The conversation history to search
 * @param agentName - Name of the agent to filter by
 * @returns Array of titles that were previously recommended
 */
function getPreviousRecommendations(conversationHistory: ConversationHistory, agentName: string): string[] {
  const previousMessages = conversationHistory.messages.filter(
    (msg) => msg.pseudonym === agentName && msg.fromAgent && msg.visible && msg.bodyType === 'json'
  )

  // Extract titles from message bodies
  const titles: string[] = []
  for (const msg of previousMessages) {
    try {
      const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body
      if (body && typeof body === 'object' && 'type' in body && body.type === 'reading') {
        titles.push(
          ...body.content
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
  previousRecsText: string,
  count: number
): string => `You are a research librarian helping participants in an academic event discover relevant readings.

Event: ${conversationName}
Speakers: ${speakerNames}
Moderators: ${moderatorNames}

Recent discussion transcript:
${transcript}

You have two tools:
  - search_semantic_scholar: search by keyword, author, or title
  - get_semantic_scholar_recommendations: get recommendations seeded by known papers

Use these tools freely to find the ${count} most relevant academic resources for the discussion.

A good approach is to search for works by the speakers/moderators first,
then use those as seed papers for Semantic Scholar recommendations — but use your judgment.

- Prioritize relevance to the specific topics raised in the transcript over general subject area.
- Aim for diverse, complementary recommendations.
- Always include the URL from search results in your recommendations when one is available.
- CRITICAL: Never recommend any of these previously recommended items: ${previousRecsText}

Provide exactly ${count} recommendations with their relevance reasons.`

export default verify({
  name: 'Librarian Agent',
  description: 'Suggests relevant academic readings based on event content',
  priority: 50,
  maxTokens: 8000,
  defaultTriggers: {
    periodic: {
      timerPeriod: 900, // 15 minutes
      conversationHistorySettings: {
        channels: ['transcript']
      }
    }
  },
  agentConfig: {
    minTranscriptLength: 100,
    recommendationsPerInterval: 2
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

    // 2. Get all previous recommendations from conversation history to avoid duplicates
    const fullHistory: ConversationHistory = {
      start: new Date(0), // Beginning of time to get all messages
      end: conversationHistory.end,
      messages: this.conversation.messages // Access all messages
    }
    const previousRecs = getPreviousRecommendations(fullHistory, this.name)
    const previousRecsText = previousRecs.length > 0 ? previousRecs.join('; ') : 'None yet'

    // 3. Build prompt
    const count = this.agentConfig.recommendationsPerInterval
    const promptText = buildPrompt(this.conversation.name, speakerNames, moderatorNames, transcript, previousRecsText, count)

    // 4. Invoke agent with structured output
    let result
    try {
      result = await getAgentStructuredResponse(
        llm,
        [searchSemanticScholarTool, getSemanticScholarRecommendationsTool],
        promptText,
        `Please provide ${count} reading recommendations based on the discussion.`,
        buildRecommendationSchema(count)
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
        channels: [resourcesChannel],
        context: `Speakers: ${speakerNames}\nModerators: ${moderatorNames}\nPrevious recommendations: ${previousRecsText}\n\nTranscript:\n${transcript}`
      }
    ]
  },

  async start() {
    return true
  },

  async stop() {
    return true
  },
  formatTraceOutput(responses) {
    return responses[0]?.message?.content
  },

  getTraceMetadata(conversationHistory, userMessage, responses) {
    return {
      context: responses[0]?.context,
      conversationHistory,
      channels: userMessage?.channels,
      topic: responses[0]?.topic
    }
  }
})
