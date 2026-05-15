import config from '../../config/config.js'
import logger from '../../config/logger.js'
import type { WebSearchResult, WebSearchParams } from './webSearch.js'

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'

const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

/** @deprecated Use {@link WebSearchResult} from webSearch.ts instead. */
export type TavilySearchResult = WebSearchResult

interface TavilySearchParams extends WebSearchParams {
  searchDepth?: 'basic' | 'advanced'
}

async function fetchWithRetry(url: string, options: Parameters<typeof fetch>[1], context: string): Promise<Response | null> {
  let serverErrorRetried = false

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(url, { ...options, signal: controller.signal })

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          logger.error(`Tavily rate limit exceeded (${context}); giving up`)
          return null
        }
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_BASE_DELAY_MS * 2 ** attempt
        logger.warn(`Tavily rate limited (${context}); retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
        clearTimeout(timeout)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      if (response.status >= 500) {
        if (serverErrorRetried) {
          logger.error(`Tavily server error ${response.status} (${context}); giving up`)
          return null
        }
        logger.warn(`Tavily server error ${response.status} (${context}); retrying immediately`)
        serverErrorRetried = true
        clearTimeout(timeout)
        continue
      }

      return response
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error(`Tavily request timed out (${context})`)
      } else {
        logger.error(`Tavily request failed (${context}): ${error instanceof Error ? error.message : String(error)}`)
      }
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  return null
}

/**
 * Search the web using the Tavily Search API.
 * Conforms to the WebSearchResult contract so it can be used as a web search provider.
 */
export async function searchTavily(params: TavilySearchParams): Promise<WebSearchResult[]> {
  const { query, searchDepth = 'basic', maxResults = 5, includeDomains, excludeDomains } = params

  const { apiKey } = config.tavily
  if (!apiKey) {
    logger.warn(
      `Tavily web search was requested but TAVILY_API_KEY is not set (query: "${query}"). ` +
        'Set TAVILY_API_KEY in the environment to enable web search.'
    )
    return []
  }

  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    search_depth: searchDepth,
    max_results: Math.min(maxResults, 20)
  }

  if (includeDomains && includeDomains.length > 0) body.include_domains = includeDomains
  if (excludeDomains && excludeDomains.length > 0) body.exclude_domains = excludeDomains

  logger.debug(`Tavily search: "${query}" (depth=${searchDepth}, max=${maxResults})`)

  const response = await fetchWithRetry(
    TAVILY_SEARCH_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    query
  )

  if (!response) return []

  if (!response.ok) {
    logger.error(`Tavily search API error: ${response.status}`)
    const errorText = await response.text()
    logger.error(`Error response body: ${errorText.substring(0, 500)}`)
    return []
  }

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; score?: number }>
  }

  const results: WebSearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.content ?? '',
    score: r.score ?? 0
  }))

  logger.debug(`Tavily search returned ${results.length} results`)
  return results
}
