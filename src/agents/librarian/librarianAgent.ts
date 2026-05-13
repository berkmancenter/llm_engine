import { z } from 'zod'
import logger from '../../config/logger.js'
import { AgentMessageActions, ConversationHistory, IMessage } from '../../types/index.types.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { formatTranscript } from '../helpers/llmInputFormatters.js'
import { getAgentStructuredResponse } from '../helpers/llmChain.js'
import verify from '../helpers/verify.js'
import { getSemanticScholarRecommendationsTool, searchSemanticScholarTool } from '../tools/semanticScholar.js'

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

function getPreviousRecommendations(resources) {
  return resources.filter((r) => r.source === 'ai').map((r) => r.title)
}

const formatPreviousRecs = (titles: string[]): string => {
  if (titles.length === 0) return 'None yet.'
  return titles.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
}

const buildPrompt = (
  conversationName: string,
  speakerNames: string,
  moderatorNames: string,
  transcript: string,
  previousRecs: string[],
  count: number
): string => `You are a research librarian helping participants in an academic event discover relevant readings.

Event: ${conversationName}
Speakers: ${speakerNames}
Moderators: ${moderatorNames}

## Already Recommended — DO NOT suggest these again
${formatPreviousRecs(previousRecs)}

If a tool returns any of the above titles, discard it and keep searching until you have ${count} titles not on this list.

## Recent discussion transcript
${transcript}

## Instructions
You have two tools:
  - search_semantic_scholar: search by keyword, author, or title
  - get_semantic_scholar_recommendations: get recommendations seeded by known papers

Use these tools freely to find the ${count} most relevant academic resources for the discussion.

A good approach is to search for works by the speakers/moderators first,
then use those as seed papers for Semantic Scholar recommendations — but use your judgment.

- Prioritize relevance to the specific topics raised in the transcript over general subject area.
- Aim for diverse, complementary recommendations.
- Always include the URL from search results in your recommendations when one is available.

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

    // 2. Get all previous AI recommendations from conversation resources to avoid duplicates
    const previousRecs = getPreviousRecommendations(this.conversation.resources || [])

    // 3. Build prompt
    const count = this.agentConfig.recommendationsPerInterval
    const promptText = buildPrompt(this.conversation.name, speakerNames, moderatorNames, transcript, previousRecs, count)

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

    // 5. Filter out any duplicates the LLM may have returned despite being instructed not to
    const previousRecsLower = new Set(previousRecs.map((t) => t.toLowerCase()))
    const deduped = result.recommendations.filter((r) => {
      if (previousRecsLower.has(r.title.toLowerCase())) {
        logger.warn(`Librarian Agent returned a previously recommended item, skipping: "${r.title}"`)
        return false
      }
      return true
    })
    result.recommendations = deduped

    // 6. Map to Resource objects and return as a typed agent response
    const resources = deduped.map((r) => ({
      source: 'ai' as const,
      category: 'suggested' as const,
      title: r.title,
      authors: r.authors,
      year: r.year?.toString(),
      url: r.url,
      relevanceReason: r.relevanceReason,
      participantVisible: true
    }))

    return [
      {
        visible: false,
        message: resources,
        messageType: 'resources',
        context: `Speakers: ${speakerNames}\nModerators: ${moderatorNames}\nPrevious recommendations: ${
          previousRecs.join('; ') || 'None yet'
        }\n\nTranscript:\n${transcript}`
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
    return responses[0]?.message
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
