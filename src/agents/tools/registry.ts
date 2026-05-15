import type { StructuredToolInterface } from '@langchain/core/tools'
import logger from '../../config/logger.js'
import { webSearchTool } from './webSearch.js'
import { searchSemanticScholarTool, getSemanticScholarRecommendationsTool } from './semanticScholar.js'
import createEventHistoryTools from './eventHistory.js'

/**
 * A factory that returns one or more LangChain tools.
 * Factories receive an optional context object so tools that need runtime data
 * (e.g. eventHistory tools need topic IDs) can be created dynamically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolFactory = (context?: Record<string, any>) => StructuredToolInterface[] | StructuredToolInterface

const factories = new Map<string, ToolFactory>()

/**
 * Register a tool factory under a given name.
 * Call at module init time — idempotent (last-write wins).
 */
export function registerTool(name: string, factory: ToolFactory): void {
  factories.set(name, factory)
}

/**
 * Resolve an array of tool names into LangChain tool instances.
 * Unknown names are logged as warnings and skipped.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getTools(names: string[], context?: Record<string, any>): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  for (const name of names) {
    const factory = factories.get(name)
    if (!factory) {
      logger.warn(`Tool registry: unknown tool "${name}" — skipping`)
      continue
    }
    const result = factory(context)
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
registerTool('search_semantic_scholar', () => searchSemanticScholarTool)
registerTool('get_semantic_scholar_recommendations', () => getSemanticScholarRecommendationsTool)

// Event history tools need runtime topic data, so use the factory pattern
registerTool('event_history', (context) => {
  const topics = context?.topics
  if (!topics || !Array.isArray(topics) || topics.length === 0) {
    logger.warn('Tool registry: event_history requested but no topics provided in context')
    return []
  }
  return createEventHistoryTools(topics)
})
