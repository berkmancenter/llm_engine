import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import { searchTavily } from './tavilySearch.js'

// ---------------------------------------------------------------------------
// Abstract web search interface — any provider must conform to this contract
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  title: string
  url: string
  content: string
  score: number
}

export interface WebSearchParams {
  query: string
  maxResults?: number
  includeDomains?: string[]
  excludeDomains?: string[]
}

type WebSearchProvider = (params: WebSearchParams) => Promise<WebSearchResult[]>

// ---------------------------------------------------------------------------
// Provider registry (internal)
// ---------------------------------------------------------------------------

const providers = new Map<string, () => WebSearchProvider>()

export function registerWebSearchProvider(name: string, factory: () => WebSearchProvider): void {
  providers.set(name, factory)
}

function getProvider(): WebSearchProvider {
  const name = config.webSearchProvider
  const factory = providers.get(name)
  if (!factory) {
    const available = Array.from(providers.keys()).join(', ')
    logger.error(`Unknown web search provider "${name}". Available: ${available}`)
    return async () => []
  }
  return factory()
}

/**
 * Search the web using whichever provider is configured via WEB_SEARCH_PROVIDER.
 */
export async function searchWeb(params: WebSearchParams): Promise<WebSearchResult[]> {
  return getProvider()(params)
}

// ---------------------------------------------------------------------------
// Built-in provider: Tavily
// ---------------------------------------------------------------------------

registerWebSearchProvider(
  'tavily',
  () => (params: WebSearchParams) =>
    searchTavily({
      query: params.query,
      maxResults: params.maxResults,
      includeDomains: params.includeDomains,
      excludeDomains: params.excludeDomains
    })
)

// ---------------------------------------------------------------------------
// LangChain tool — provider-agnostic
// ---------------------------------------------------------------------------

export const webSearchTool = tool(
  async ({ query, maxResults, includeDomains, excludeDomains }) => {
    const results = await searchWeb({ query, maxResults, includeDomains, excludeDomains })
    if (results.length === 0) return 'No results found.'
    return results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`).join('\n\n')
  },
  {
    name: 'web_search',
    description:
      'Search the public web for facts that are missing, uncertain, time-sensitive, or need verification beyond the event transcript and chat supplied in this request. ' +
      'Use when the user needs post-knowledge-cutoff updates, verifiable third-party details, or anything you would otherwise infer from memory instead of from cited context. ' +
      'Returns titled, numbered results with URLs and snippets. **Default:** if unsure whether context alone suffices, call this tool rather than guessing. ' +
      '**Omit only** when your entire reply will restate or tightly paraphrase information explicitly present in that supplied context and chat, with no material external factual claims. ' +
      '**When using results:** cite the source title and URL in your response.',
    schema: z.object({
      query: z.string().describe('The search query to look up on the web.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Maximum number of results to return (default 5, max 20).'),
      includeDomains: z
        .array(z.string())
        .optional()
        .describe('Optional list of domains to restrict search to, e.g. ["arxiv.org", "nature.com"].'),
      excludeDomains: z.array(z.string()).optional().describe('Optional list of domains to exclude from search results.')
    })
  }
)

/**
 * System prompt guidance for web_search. Frames it as a last resort after other tools.
 */
export function buildWebSearchPrompt(): string {
  return `**Web search:**
Use \`web_search\` only for general knowledge or current events that the other available tools cannot answer. Try those first. Cite sources inline — never state a fact from search results without attribution. Don't suggest the user check an external site without having searched it yourself first.`
}
