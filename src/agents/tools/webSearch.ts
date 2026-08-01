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

export interface WebSearchToolConfig {
  maxResults?: number
}

/**
 * Static, tool-intrinsic guidance on when/how to use web_search — registered on the tool
 * so any agent that ends up with web_search active gets it automatically (see registry.ts).
 * Kept under its original exported name via a re-export in buildEventAssistantToolSystemPrompt.ts
 * so existing tests locking the wording don't need to change.
 */
export const WEB_SEARCH_USAGE_GUIDANCE = `**Tools (web search):**
You have access to \`web_search\` for the public web.

**Default — search first when not certain:** If you cannot **state with certainty** that **every substantive factual claim** in your answer is **directly supported** by the **Context** (recent transcript + retrieved chunks) and the **conversation history** you were given—**not** from training-time memory, knowledge after your cutoff, or guesswork—**you MUST call \`web_search\` at least once before replying**. When you are **uncertain**, **prefer running \`web_search\` over answering without it**; a redundant search is acceptable; **confident guessing or filling gaps from memory is not**.

**Call \`web_search\` when** (non-exhaustive): facts that may have changed after your training cutoff or need "latest" confirmation; statistics, dates, regulations, product or version facts; verifiable claims about the **wider world** the discussion depends on; **incomplete** lists, rosters, or details **mentioned** in the event when the user asks for more than the Context literally contains; anything you would otherwise **infer** without a cited source in Context.

**Do NOT call \`web_search\`** only when you will answer **solely** by summarizing, explaining, or closely paraphrasing what is **explicitly or unambiguously** already in Context + chat, with **no** material reliance on unchecked external facts. **Background Reading chunks in the Context are authoritative sources — treat them the same as transcript context; do not search for information already covered there.**

**IMPORTANT — use tools instead of suggesting sources:** Do NOT tell the user to "check" or "look at" external sites or reports without having called \`web_search\` yourself in this turn—run the search and synthesize what you find.

**If you use \`web_search\`:** Keep queries tightly scoped to the missing or uncertain facts. If results are empty or useless, say so briefly, then answer from Context and clearly-labeled general knowledge.

**Citing web search results (mandatory):** When your response uses information from \`web_search\` results, you MUST attribute it — include the source title and URL inline (e.g. "According to [Title](URL), ...") or as a numbered reference at the end. Never state a fact drawn from search results without citing its source.

**Never narrate your tool decisions in your response.** Do not explain why you did or did not search, or comment on what the context contains. Just answer the question.`

/**
 * Builds the web_search LangChain tool. `config.maxResults`, when given, becomes the schema's
 * default maxResults (the LLM can still pass a different value per call).
 */
export function createWebSearchTool(toolConfig: WebSearchToolConfig = {}) {
  return tool(
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
          .default(toolConfig.maxResults ?? 5)
          .describe(`Maximum number of results to return (default ${toolConfig.maxResults ?? 5}, max 20).`),
        includeDomains: z
          .array(z.string())
          .optional()
          .describe('Optional list of domains to restrict search to, e.g. ["arxiv.org", "nature.com"].'),
        excludeDomains: z.array(z.string()).optional().describe('Optional list of domains to exclude from search results.')
      })
    }
  )
}

export const webSearchTool = createWebSearchTool()
