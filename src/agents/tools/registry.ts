import type { StructuredToolInterface } from '@langchain/core/tools'
import logger from '../../config/logger.js'
import { webSearchTool, buildWebSearchPrompt } from './webSearch.js'
import { searchSemanticScholarTool, getSemanticScholarRecommendationsTool } from './semanticScholar.js'
import createEventHistoryTools, { TopicRef, buildEventHistoryToolsPrompt } from './eventHistory.js'
import Topic from '../../models/topic.model.js'
import { bkcArchiveWikiTools, buildArchiveWikiToolsPrompt } from './bkcArchiveWiki.js'

/**
 * A factory that returns one or more LangChain tools, optionally async.
 * Factories receive an optional context object so tools that need runtime data
 * (e.g. eventHistory tools need topic IDs) can be created dynamically.
 */
type ToolContext = Record<string, unknown>
type ToolFactory = (
  context?: ToolContext
) =>
  | StructuredToolInterface[]
  | StructuredToolInterface
  | Promise<StructuredToolInterface[]>
  | Promise<StructuredToolInterface>

type ToolPromptBuilder = (context?: ToolContext) => string | null | Promise<string | null>

const factories = new Map<string, ToolFactory>()
const promptBuilders = new Map<string, ToolPromptBuilder>()

/**
 * Register a tool factory under a given name.
 * Call at module init time — idempotent (last-write wins).
 */
export function registerTool(name: string, factory: ToolFactory): void {
  factories.set(name, factory)
}

/**
 * Register a system-prompt guidance builder for a tool.
 * The builder receives the same context object as the tool factory.
 * Return null to suppress the section (e.g. when the tool is not configured).
 */
export function registerToolPrompt(name: string, builder: ToolPromptBuilder): void {
  promptBuilders.set(name, builder)
}

/**
 * Assemble system-prompt guidance for a list of tool names.
 * Sections are separated by a blank line. Unknown names are silently skipped.
 */
export async function buildToolsGuidance(names: string[], context?: ToolContext): Promise<string> {
  const sections: string[] = []
  for (const name of names) {
    const builder = promptBuilders.get(name)
    if (!builder) continue
    const result = await Promise.resolve(builder(context))
    if (result) sections.push(result)
  }
  return sections.length > 0 ? `${sections.join('\n\n')}\n\n` : ''
}

/**
 * Resolve an array of tool names into LangChain tool instances.
 * Unknown names are logged as warnings and skipped.
 */
export async function getTools(names: string[], context?: ToolContext): Promise<StructuredToolInterface[]> {
  const tools: StructuredToolInterface[] = []
  for (const name of names) {
    const factory = factories.get(name)
    if (!factory) {
      logger.warn(`Tool registry: unknown tool "${name}" — skipping`)
      continue
    }
    const result = await Promise.resolve(factory(context))
    if (Array.isArray(result)) {
      tools.push(...result)
    } else {
      tools.push(result)
    }
  }
  return tools
}

/**
 * List all registered tool names (useful for diagnostics).
 */
export function listRegisteredTools(): string[] {
  return Array.from(factories.keys())
}

// ---------------------------------------------------------------------------
// Built-in registrations
// ---------------------------------------------------------------------------

registerTool('tavily_search', () => webSearchTool)
registerTool('web_search', () => webSearchTool)
registerToolPrompt('web_search', () => buildWebSearchPrompt())
registerTool('search_semantic_scholar', () => searchSemanticScholarTool)
registerTool('get_semantic_scholar_recommendations', () => getSemanticScholarRecommendationsTool)

registerTool('bkc_archive_wiki', () => bkcArchiveWikiTools)
registerToolPrompt('bkc_archive_wiki', () => (bkcArchiveWikiTools.length > 0 ? buildArchiveWikiToolsPrompt() : null))

// Event history tools load topics from DB at request time.
// Accepts topicIds (string[]) for scoped access, falling back to pre-resolved topics for
// callers (e.g. eventAssistant) that still pass them directly.
registerTool('event_history', async (context) => {
  const topicIds = context?.topicIds
  let topics: TopicRef[] | undefined = Array.isArray(context?.topics) ? (context.topics as TopicRef[]) : undefined

  if (Array.isArray(topicIds) && topicIds.every((id) => typeof id === 'string')) {
    const ids = topicIds as string[]
    const docs =
      ids.length > 0
        ? await Topic.find({ _id: { $in: ids } })
            .select('_id name description')
            .lean()
        : await Topic.find({ private: false, isDeleted: false }).select('_id name description').lean()
    topics = docs.map((t) => ({ id: t._id.toString(), name: t.name, description: t.description }))
  }

  if (!topics || topics.length === 0) {
    logger.warn('Tool registry: event_history requested but no topics could be resolved from context')
    return []
  }
  const activeConversationId = typeof context?.activeConversationId === 'string' ? context.activeConversationId : undefined
  return createEventHistoryTools(topics, { activeConversationId })
})
registerToolPrompt('event_history', async (context) => {
  const topicIds = Array.isArray(context?.topicIds) ? (context.topicIds as string[]) : []
  return buildEventHistoryToolsPrompt(false, topicIds)
})
