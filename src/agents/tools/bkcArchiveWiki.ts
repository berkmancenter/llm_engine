import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import logger from '../../config/logger.js'
import config from '../../config/config.js'

/**
 * Tools that connect an agent to the BKC archive wiki API:
 *:
 *  - search_archive                 keyword search via GET /v1/search
 *  - list_archive_wiki_pages        GET /v1/pages
 *  - read_archive_wiki_page         GET /v1/pages/:section/:slug
 *  - get_archive_item               GET /v1/items/:id
 *
 */

const API_TIMEOUT_MS = 15000
const API_MAX_RETRIES = 2
const API_RETRY_BASE_DELAY_MS = 500
const API_SECTIONS = ['topics', 'people', 'orgs', 'events', 'timeline'] as const
const API_UNAVAILABLE = 'The archive is not reachable right now. Answer from other sources or try again later.'

export interface ArchiveToolsSource {
  apiUrl: string
  apiToken?: string
}

/** Fetch-with-timeout-and-retry for the archive-wiki API, mirroring tavilySearch.ts's
 * resilience against transient 429/5xx — one retry on a server error, backoff on rate limit. */
async function archiveApiRequest(
  apiUrl: string,
  apiToken: string | undefined,
  endpoint: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; data } | null> {
  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (apiToken) headers.Authorization = `Bearer ${apiToken}`
      const response = await fetch(`${apiUrl.replace(/\/+$/, '')}${endpoint}`, {
        method: init?.method || 'GET',
        headers,
        body: init?.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal
      })
      if ((response.status === 429 || response.status >= 500) && attempt < API_MAX_RETRIES) {
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : API_RETRY_BASE_DELAY_MS * 2 ** attempt
        logger.warn(`Archive API ${response.status} (${endpoint}); retrying in ${delay}ms`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      const data = await response.json().catch(() => null)
      return { status: response.status, data }
    } catch (error) {
      logger.warn(`Archive API request failed (${endpoint}): ${error.message}`)
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
  return null
}

function apiErrorText(result: { status: number; data }): string | null {
  if (result.status === 401) return 'The archive API rejected the configured credentials (check ARCHIVE_API_TOKEN).'
  if (result.status >= 400) return result.data?.message || `Archive API error (HTTP ${result.status}).`
  return null
}

function createArchiveApiTools(apiUrl: string, apiToken?: string) {
  const searchArchiveTool = tool(
    async ({ query, section }) => {
      const params = new URLSearchParams({ q: query, limit: '10' })
      if (section) params.set('section', section)
      const result = await archiveApiRequest(apiUrl, apiToken, `/v1/search?${params}`)
      if (!result) return API_UNAVAILABLE
      const error = apiErrorText(result)
      if (error) return error
      const results = result.data?.results || []
      if (results.length === 0) return 'No relevant archive content found.'
      return results
        .map((r) => {
          const ref = r.id ? `item ${r.id}` : `${r.section}/${r.slug}`
          return `- [${ref}] "${r.title}"\n  ${r.snippet}`
        })
        .join('\n')
    },
    {
      name: 'search_archive',
      description:
        'Keyword search across the BKC archive wiki: curated topic/people/org/event/timeline pages and all archive ' +
        'item stubs. Use this for content questions about what the archive holds. Results reference either an item id ' +
        '(drill in with get_archive_item) or a wiki page as section/slug (open with read_archive_wiki_page). ' +
        'This is exact-term matching, not semantic search — prefer concrete names and terms over paraphrases.',
      schema: z.object({
        query: z.string().describe('The search query, e.g. "content moderation", "Zittrain Polymarket"'),
        section: z
          .enum([...API_SECTIONS, 'items'])
          .optional()
          .describe('Limit results to one section, or "items" for archive item stubs. Omit to search everything.')
      })
    }
  )

  const listWikiPagesTool = tool(
    async ({ section }) => {
      const result = await archiveApiRequest(apiUrl, apiToken, `/v1/pages${section ? `?section=${section}` : ''}`)
      if (!result) return API_UNAVAILABLE
      const error = apiErrorText(result)
      if (error) return error
      const pages = result.data?.pages || []
      if (pages.length === 0) return 'No wiki pages found.'
      return pages
        .map((p) => {
          const extras = [
            p.meta?.item_count ? `${p.meta.item_count} items` : null,
            p.meta?.related ? `related: ${p.meta.related}` : null,
            p.meta?.related_topics ? `topics: ${p.meta.related_topics}` : null,
            p.meta?.affiliations ? `affiliations: ${p.meta.affiliations}` : null
          ]
            .filter(Boolean)
            .join(' | ')
          return `- [${p.section}] ${p.slug} — "${p.title}"${extras ? ` (${extras})` : ''}`
        })
        .join('\n')
    },
    {
      name: 'list_archive_wiki_pages',
      description:
        'List the curated archive-wiki pages: thematic topic pages, people, organizations, events, and per-year ' +
        'timeline narratives. Use this first to route a question about a theme, person, org, or era to the right ' +
        'page, then call read_archive_wiki_page with the slug.',
      schema: z.object({
        section: z
          .enum([...API_SECTIONS])
          .optional()
          .describe('Limit to one section: topics, people, orgs, events, or timeline. Omit to list all.')
      })
    }
  )

  const readWikiPageTool = tool(
    async ({ slug, section }) => {
      const endpoint = section ? `/v1/pages/${section}/${encodeURIComponent(slug)}` : `/v1/pages/${encodeURIComponent(slug)}`
      const result = await archiveApiRequest(apiUrl, apiToken, endpoint)
      if (!result) return API_UNAVAILABLE
      if (result.status === 404) {
        return `No wiki page found for slug "${slug}". Use list_archive_wiki_pages to see valid slugs.`
      }
      const error = apiErrorText(result)
      if (error) return error
      return result.data?.markdown || 'The page is empty.'
    },
    {
      name: 'read_archive_wiki_page',
      description:
        'Read one curated archive-wiki page by slug (from list_archive_wiki_pages or search_archive). Pages link to ' +
        'archive items as wiki-links like [[<itemId>-<slug>|Title]] — pass that leading itemId (e.g. "17120704" or ' +
        '"yt_BSt010su3rU") to get_archive_item to retrieve the underlying source material.',
      schema: z.object({
        slug: z.string().describe('The page slug, e.g. "ai-governance-and-regulation" or "jonathan-zittrain"'),
        section: z
          .enum([...API_SECTIONS])
          .optional()
          .describe('Which section the slug is in, if known. Omit to search all sections.')
      })
    }
  )

  const getArchiveItemTool = tool(
    async ({ id }) => {
      const result = await archiveApiRequest(apiUrl, apiToken, `/v1/items/${encodeURIComponent(id)}`)
      if (!result) return API_UNAVAILABLE
      if (result.status === 404) {
        return `No archive item found with id "${id}". Ids come from wiki-links ([[<id>-<slug>|...]]) or search_archive results.`
      }
      const error = apiErrorText(result)
      if (error) return error
      return result.data?.markdown || 'The item is empty.'
    },
    {
      name: 'get_archive_item',
      description:
        'Retrieve one archive item by id: its stub metadata plus the full source material when available ' +
        '(YouTube transcript for "yt_..." ids, article/newsletter full text for numeric ids). Use ids surfaced ' +
        'by read_archive_wiki_page wiki-links or search_archive results.',
      schema: z.object({
        id: z.string().describe('The archive item id, e.g. "17120704" or "yt_BSt010su3rU". Not the title.')
      })
    }
  )

  return [searchArchiveTool, listWikiPagesTool, readWikiPageTool, getArchiveItemTool]
}

export const bkcArchiveWikiTools = config.bkcArchive.apiUrl
  ? createArchiveApiTools(config.bkcArchive.apiUrl, config.bkcArchive.apiToken)
  : []

export function buildArchiveWikiToolsPrompt(): string {
  return `**Archive tools:**
You also have access to the BKC archive — a curated collection of video transcripts, articles, newsletters, and bookmarked items, organized by a wiki of topic, people, org, and timeline pages.

- \`search_archive\`: keyword search across all archive content — use for questions about what the archive holds (talks, writings, coverage of a subject); prefer concrete names and terms over paraphrases
- \`list_archive_wiki_pages\`: list the curated wiki pages — use to route a thematic question (a topic, person, organization, or era) to the right page
- \`read_archive_wiki_page\`: read one wiki page; its wiki-links carry archive item ids
- \`get_archive_item\`: fetch one item's metadata plus full source material (transcript or article text) by id

For direct content questions, go straight to \`search_archive\`. For thematic or survey questions ("what does the archive have on X", questions about a person/org/era), route through the wiki: \`list_archive_wiki_pages\` → \`read_archive_wiki_page\` → \`get_archive_item\` for the sources you need. Cite items by title, date, and URL. Event transcripts (the tools above) and the archive are different bodies of material — talks, videos, interviews, articles, and newsletters usually live in the archive. Budget your tool calls: if an event-history search returns nothing relevant, switch to \`search_archive\` instead of retrying variations of the same search.`
}
