import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import config from '../../config/config.js'
import logger from '../../config/logger.js'

const SEMANTIC_SCHOLAR_SEARCH_URL = 'https://api.semanticscholar.org/graph/v1/paper/search'
const SEMANTIC_SCHOLAR_RECOMMENDATIONS_URL = 'https://api.semanticscholar.org/recommendations/v1/papers'

// Fields available from the Semantic Scholar paper object
const AVAILABLE_FIELDS = [
  'paperId',
  'title',
  'authors',
  'year',
  'abstract',
  'citationCount',
  'referenceCount',
  'influentialCitationCount',
  'isOpenAccess',
  'openAccessPdf',
  'fieldsOfStudy',
  'publicationTypes',
  'publicationDate',
  'externalIds',
  'url',
  'citationStyles'
] as const

type AvailableField = (typeof AVAILABLE_FIELDS)[number]

const DEFAULT_FIELDS: AvailableField[] = ['paperId', 'title', 'authors', 'year', 'citationCount', 'publicationTypes', 'url']

export interface SemanticScholarPaper {
  paperId?: string
  title?: string
  authors?: Array<{ authorId: string; name: string }>
  year?: number
  abstract?: string
  citationCount?: number
  referenceCount?: number
  influentialCitationCount?: number
  isOpenAccess?: boolean
  openAccessPdf?: { url: string; status: string } | null
  fieldsOfStudy?: string[]
  publicationTypes?: string[]
  publicationDate?: string
  externalIds?: Record<string, string>
  url?: string
  citationStyles?: { bibtex: string }
}

export interface PaperReference {
  /** Semantic Scholar paper ID (40-char hex) or prefixed ID like "DOI:..." or "ARXIV:...". */
  paperId: string
}

interface RecommendationParams {
  positivePapers: PaperReference[]
  negativePapers?: PaperReference[]
  fields?: AvailableField[]
  limit?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000

function semanticScholarHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra }
  if (config.semanticScholar.apiKey) headers['x-api-key'] = config.semanticScholar.apiKey
  return headers
}

/**
 * Fetches a URL with retries:
 * - 429: exponential backoff up to MAX_RETRIES (respects Retry-After header)
 * - 5xx: one immediate retry only (transient server errors)
 * - other errors: fail fast
 * Returns the Response on success, or null if all attempts are exhausted.
 */
async function fetchWithRetry(url: string, options: Parameters<typeof fetch>[1], context: string): Promise<Response | null> {
  let serverErrorRetried = false

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(url, { ...options, signal: controller.signal })

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) {
          logger.error(`Semantic Scholar rate limit exceeded (${context}); giving up`)
          return null
        }
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : RETRY_BASE_DELAY_MS * 2 ** attempt
        logger.warn(`Semantic Scholar rate limited (${context}); retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
        clearTimeout(timeout)
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      if (response.status >= 500) {
        if (serverErrorRetried) {
          logger.error(`Semantic Scholar server error ${response.status} (${context}); giving up`)
          return null
        }
        logger.warn(`Semantic Scholar server error ${response.status} (${context}); retrying immediately`)
        serverErrorRetried = true
        clearTimeout(timeout)
        continue
      }

      return response
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error(`Semantic Scholar request timed out (${context})`)
      } else {
        logger.error(`Semantic Scholar request failed (${context}): ${error instanceof Error ? error.message : String(error)}`)
      }
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  return null
}

/**
 * Fetch paper recommendations from the Semantic Scholar Recommendations API.
 */
export async function getRecommendations(params: RecommendationParams): Promise<SemanticScholarPaper[]> {
  const { positivePapers, negativePapers = [], fields, limit = 10, sortBy, sortOrder = 'desc' } = params

  const positivePaperIds = positivePapers.map((p) => p.paperId)
  const negativePaperIds = negativePapers.map((p) => p.paperId)

  if (positivePaperIds.length === 0) {
    logger.warn('No positive paper IDs provided; skipping recommendations call')
    return []
  }

  logger.debug(`Fetching recommendations for positive IDs: ${positivePaperIds.join(', ')}`)

  const queryParams = new URLSearchParams()
  const requestedFields = fields && fields.length > 0 ? fields : DEFAULT_FIELDS
  const fieldsWithTypes = requestedFields.includes('publicationTypes')
    ? requestedFields
    : [...requestedFields, 'publicationTypes']
  queryParams.set('fields', fieldsWithTypes.join(','))
  // Fetch more candidates than requested so filtering by publicationTypes still yields enough results
  const fetchLimit = Math.min(limit * 10, 500)
  queryParams.set('limit', fetchLimit.toString())

  const url = `${SEMANTIC_SCHOLAR_RECOMMENDATIONS_URL}?${queryParams.toString()}`

  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: semanticScholarHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ positivePaperIds, negativePaperIds })
    },
    'recommendations'
  )

  if (!response) return []

  if (!response.ok) {
    logger.error(`Semantic Scholar Recommendations API error: ${response.status}`)
    const errorText = await response.text()
    logger.error(`Error response body: ${errorText.substring(0, 500)}`)
    return []
  }

  const data = (await response.json()) as { recommendedPapers: SemanticScholarPaper[] }
  const allowedPublicationTypes = new Set([
    'JournalArticle',
    'Conference',
    'Review',
    'Book',
    'BookSection',
    'MetaAnalysis',
    'ClinicalTrial',
    'CaseReport',
    'Editorial',
    'LettersAndComments',
    'Study'
  ])
  let papers = (data.recommendedPapers ?? []).filter((p) => {
    const allowed = p.publicationTypes && p.publicationTypes.some((t) => allowedPublicationTypes.has(t))
    if (!allowed) {
      logger.debug(
        `Filtered out recommendation "${p.title}" (paperId: ${p.paperId}, publicationTypes: ${JSON.stringify(p.publicationTypes)})`
      )
    }
    return allowed
  })

  if (sortBy) {
    papers = papers.sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[sortBy]
      const bVal = (b as Record<string, unknown>)[sortBy]

      if (aVal === undefined || aVal === null) return 1
      if (bVal === undefined || bVal === null) return -1

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal
      }

      const cmp = String(aVal).localeCompare(String(bVal))
      return sortOrder === 'asc' ? cmp : -cmp
    })
  }
  papers = papers.slice(0, limit)
  logger.debug(`Returning ${papers.length} recommendations from Semantic Scholar API`)
  return papers
}

interface SearchParams {
  query: string
  fields?: AvailableField[]
  year?: string
  fieldsOfStudy?: string
  minCitationCount?: number
  limit?: number
}

/**
 * Search Semantic Scholar for papers by keyword, author, or title using the relevance search endpoint.
 * Results are ranked by relevance (text match + citation influence).
 */
export async function searchPapers(params: SearchParams): Promise<SemanticScholarPaper[]> {
  const { query, fields, year, fieldsOfStudy, minCitationCount, limit = 10 } = params

  const queryParams = new URLSearchParams({ query })
  if (fields && fields.length > 0) queryParams.set('fields', fields.join(','))
  if (year) queryParams.set('year', year)
  if (fieldsOfStudy) queryParams.set('fieldsOfStudy', fieldsOfStudy)
  if (minCitationCount !== undefined) queryParams.set('minCitationCount', String(minCitationCount))
  queryParams.set(
    'publicationTypes',
    'JournalArticle,Conference,Review,Book,BookSection,MetaAnalysis,ClinicalTrial,CaseReport,Editorial,LettersAndComments,Study'
  )
  queryParams.set('limit', String(Math.min(limit, 100)))

  const url = `${SEMANTIC_SCHOLAR_SEARCH_URL}?${queryParams.toString()}`
  logger.debug(`Semantic Scholar relevance search: ${url}`)

  const response = await fetchWithRetry(url, { headers: semanticScholarHeaders() }, query)

  if (!response) return []

  if (!response.ok) {
    logger.error(`Semantic Scholar search API error: ${response.status}`)
    const errorText = await response.text()
    logger.error(`Error response body: ${errorText.substring(0, 500)}`)
    return []
  }

  const data = (await response.json()) as { total?: number; data?: SemanticScholarPaper[] }
  const papers = data.data ?? []
  logger.debug(`Semantic Scholar relevance search returned ${papers.length} results (total: ${data.total ?? 'unknown'})`)
  return papers
}

/**
 * Tool definition for LangChain.
 * Searches Semantic Scholar for papers by keyword, author, or title.
 */
export const searchSemanticScholarTool = tool(
  async ({ query, fields, year, fieldsOfStudy, minCitationCount, limit }) => {
    const results = await searchPapers({
      query,
      fields: (fields as AvailableField[] | undefined) ?? DEFAULT_FIELDS,
      year,
      fieldsOfStudy,
      minCitationCount,
      limit
    })
    return JSON.stringify(results)
  },
  {
    name: 'search_semantic_scholar',
    description:
      'Search Semantic Scholar for academic papers by keyword, author name, or title. ' +
      'Results are ranked by relevance, factoring in text match quality and citation influence. ' +
      'Use this to discover papers on a topic or find works by a specific author.',
    schema: z.object({
      query: z
        .string()
        .describe('Search query matched against paper title and abstract. Can include author names, keywords, or titles.'),
      fields: z
        .array(z.enum(AVAILABLE_FIELDS))
        .optional()
        .describe(
          `Fields to include in each result. Defaults to: ${DEFAULT_FIELDS.join(', ')}. Available: ${AVAILABLE_FIELDS.join(
            ', '
          )}.`
        ),
      year: z.string().optional().describe('Filter by publication year or range, e.g. "2020" or "2018-2023".'),
      fieldsOfStudy: z
        .string()
        .optional()
        .describe('Comma-separated academic fields to filter by, e.g. "Computer Science,Medicine".'),
      minCitationCount: z
        .number()
        .int()
        .optional()
        .describe('Minimum number of citations a paper must have to appear in results.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe('Maximum number of papers to return (default 10, max 100).')
    })
  }
)

const paperReferenceSchema = z.object({
  paperId: z.string().describe('Semantic Scholar paper ID from a prior search_semantic_scholar call.')
})

/**
 * Tool definition for LangChain.
 * Resolves papers by title/author via Semantic Scholar search, then fetches
 * recommendations, with optional client-side sorting by any returned field.
 */
export const getSemanticScholarRecommendationsTool = tool(
  async ({ positivePapers, negativePapers, fields, limit, sortBy, sortOrder }) => {
    const results = await getRecommendations({
      positivePapers,
      negativePapers,
      fields: (fields as AvailableField[] | undefined) ?? DEFAULT_FIELDS,
      limit,
      sortBy,
      sortOrder
    })
    return JSON.stringify(results)
  },
  {
    name: 'get_semantic_scholar_recommendations',
    description:
      'Fetch recommended academic papers from Semantic Scholar based on one or more seed paper IDs. ' +
      'Use paperIds returned by search_semantic_scholar as seeds. ' +
      'Results can be sorted by any returned field (e.g., sortBy="citationCount" to surface the most-cited recommendations first).',
    schema: z.object({
      positivePapers: z
        .array(paperReferenceSchema)
        .min(1)
        .describe('One or more seed papers to base recommendations on. Use paperIds from search_semantic_scholar results.'),
      negativePapers: z
        .array(paperReferenceSchema)
        .optional()
        .describe(
          'Optional papers to down-rank similar recommendations. Use paperIds from search_semantic_scholar results.'
        ),
      fields: z
        .array(z.enum(AVAILABLE_FIELDS))
        .optional()
        .describe(
          `Fields to include in each returned paper. Defaults to: ${DEFAULT_FIELDS.join(', ')}. ` +
            `Available fields: ${AVAILABLE_FIELDS.join(', ')}.`
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(10)
        .describe('Maximum number of papers to return (default 10, max 500).'),
      sortBy: z
        .string()
        .optional()
        .describe(
          'Field to sort results by after fetching (e.g., "citationCount", "year", "influentialCitationCount"). ' +
            'Papers missing the field are sorted last.'
        ),
      sortOrder: z
        .enum(['asc', 'desc'])
        .default('desc')
        .describe('Sort direction: "desc" (default) for highest-first, "asc" for lowest-first.')
    })
  }
)
