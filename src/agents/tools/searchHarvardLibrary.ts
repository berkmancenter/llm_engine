import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import config from '../../config/config.js'
import logger from '../../config/logger.js'

export interface LibraryItem {
  title: string
  authors: string[]
  year?: number
  abstract?: string
  subjects?: string[] // Topics/subjects for relevance matching
  publisher?: string // Indicates academic vs popular press
  resourceType?: string // e.g., "text", "electronic resource"
  language?: string // Important for usability
}

interface SearchParams {
  keyword?: string // keyword search
  author?: string // author search
  title?: string // title search
  subject?: string // topic/subject search
  limit?: number
}

/**
 * Helper to ensure a field is an array
 */
function ensureArray(field: unknown): unknown[] {
  if (Array.isArray(field)) {
    return field
  }
  if (field) {
    return [field]
  }
  return []
}

/**
 * Parse LibraryCloud MODS API response structure
 */
function parseAPIResponse(apiResponse: Record<string, unknown>): LibraryItem[] {
  // Check pagination to distinguish "no results" from "missing data"
  const pagination = apiResponse.pagination as Record<string, unknown> | undefined
  const numFound = pagination?.numFound as number | undefined

  const itemsContainer = apiResponse.items as Record<string, unknown> | undefined
  if (!itemsContainer) {
    if (numFound === 0) {
      logger.debug('API returned no results (numFound=0)')
    } else {
      logger.warn('API response missing "items" field (unexpected)')
    }
    return []
  }

  // API returns a single object when numFound=1, array when numFound>1
  // Use ensureArray to normalize this
  const items = ensureArray(itemsContainer.mods)

  logger.debug(`Processing ${items.length} items from API response`)

  return (items as Array<Record<string, unknown>>)
    .map((item: Record<string, unknown>) => {
      // Extract title
      const titleInfoArray = ensureArray(item.titleInfo)
      const title = (titleInfoArray as Array<Record<string, unknown>>)[0]?.title || 'Untitled'

      // Extract authors from name array, filtering for creator/author roles
      const nameArray = ensureArray(item.name)

      const authors = (nameArray as Array<Record<string, unknown>>)
        .filter((n: Record<string, unknown>) => {
          const roles = ensureArray(n.role)

          return (roles as Array<Record<string, unknown>>).some((r: Record<string, unknown>) => {
            const roleTerm = (r.roleTerm as Record<string, unknown>)?.['#text'] || r.roleTerm || ''
            return ['creator', 'author', 'aut'].includes(String(roleTerm).toLowerCase())
          })
        })
        .map((n: Record<string, unknown>) => {
          const { namePart } = n
          // namePart can be a string, an array of strings, or an array of objects with #text
          if (typeof namePart === 'string') return namePart
          if (Array.isArray(namePart)) {
            // Find the main name (not date)
            const mainName = namePart.find(
              (part: unknown) =>
                typeof part === 'string' ||
                (typeof part === 'object' && part !== null && !((part as Record<string, unknown>)['@type'] === 'date'))
            )
            if (typeof mainName === 'string') return mainName
            if (typeof mainName === 'object' && mainName !== null) {
              return (mainName as Record<string, unknown>)['#text'] as string
            }
          }
          return namePart
        })
        .filter(Boolean)
        .map(String)

      // Extract year from originInfo
      const originInfoArray = ensureArray(item.originInfo)
      const originInfo = (originInfoArray as Array<Record<string, unknown>>)[0]

      const dateIssuedRaw = originInfo?.dateIssued
      const copyrightDateRaw = originInfo?.copyrightDate

      // Handle both string and object formats for dates
      const dateIssued =
        typeof dateIssuedRaw === 'string'
          ? dateIssuedRaw
          : ((dateIssuedRaw as Record<string, unknown>)?.['#text'] as string | undefined)
      const copyrightDate =
        typeof copyrightDateRaw === 'string'
          ? copyrightDateRaw
          : ((copyrightDateRaw as Record<string, unknown>)?.['#text'] as string | undefined)

      const yearStr = dateIssued || copyrightDate

      // Extract abstract or table of contents
      const abstractRaw =
        (item.abstract as Record<string, unknown>)?.['#text'] ||
        (item.abstract as string[])?.[0] ||
        (item.tableOfContents as string[])?.[0]
      const abstract = abstractRaw ? String(abstractRaw).substring(0, 300) : undefined

      // Extract subjects/topics
      const subjectArray = ensureArray(item.subject)

      const subjects = (subjectArray as Array<Record<string, unknown>>)
        .flatMap((s: Record<string, unknown>) => {
          const topics = ensureArray(s.topic)
          return topics
        })
        .filter(Boolean)
        .map(String)

      // Extract publisher (reuse originInfoArray from above)
      const publisher = originInfoArray.map((o: Record<string, unknown>) => o.publisher as string).find(Boolean)

      // Extract resource type
      const resourceType = item.typeOfResource as string | undefined

      // Extract language
      const languageField = item.language as Record<string, unknown> | undefined
      const languageTermField = languageField?.languageTerm
      let languageTerms: unknown[] = []
      if (Array.isArray(languageTermField)) {
        languageTerms = languageTermField
      } else if (languageTermField) {
        languageTerms = [languageTermField]
      }

      const language = (languageTerms as Array<Record<string, unknown>>).find(
        (lt: Record<string, unknown>) => lt['@type'] === 'text'
      )?.['#text'] as string | undefined

      return {
        title: String(title),
        authors: authors.length > 0 ? authors.map(String) : ['Unknown'],
        year: yearStr ? parseInt(String(yearStr), 10) : undefined,
        abstract,
        subjects: subjects.length > 0 ? subjects : undefined,
        publisher: publisher ? String(publisher).replace(/[,:;]+$/, '') : undefined,
        resourceType,
        language
      }
    })
    .filter((item: LibraryItem) => item.title !== 'Untitled') // Only return items with valid titles
}

/**
 * Search Harvard Library Cloud API
 *
 * @param searchParams - Search parameters (q for keyword, name for author, title for title, subject for topic)
 * @param apiUrl - Base API URL
 * @returns Array of library items
 */
export async function searchLibrary(searchParams: SearchParams, apiUrl: string): Promise<LibraryItem[]> {
  // Build query string from parameters
  const params = new URLSearchParams()
  if (searchParams.keyword) params.append('q', searchParams.keyword)
  if (searchParams.author) params.append('name', searchParams.author)
  if (searchParams.title) params.append('title', searchParams.title)
  if (searchParams.subject) params.append('subject', searchParams.subject)
  if (searchParams.limit) params.append('limit', searchParams.limit.toString())

  const url = `${apiUrl}?${params.toString()}`

  logger.debug(`Harvard Library API request: ${url}`)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    })

    if (!response.ok) {
      logger.error(`Harvard Library API error: ${response.status}`)
      const errorText = await response.text()
      logger.error(`Error response body: ${errorText.substring(0, 500)}`)
      return []
    }

    const data = (await response.json()) as Record<string, unknown>

    return parseAPIResponse(data)
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.error('Harvard Library API request timed out')
    } else if (error instanceof Error) {
      logger.error(`Harvard Library API request failed: ${error.message}`)
      logger.error(`Error stack: ${error.stack}`)
    } else {
      logger.error(`Harvard Library API request failed: ${String(error)}`)
    }
    logger.error(`Failed request URL: ${url}`)
    return []
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Tool definition for LangChain
 * Bundles the search implementation with its schema for automatic execution
 */
export const searchLibraryTool = tool(
  async ({ keyword, author, title, subject, limit = 10 }) => {
    const results = await searchLibrary({ keyword, author, title, subject, limit }, config.harvardLibrary.baseUrl)
    return JSON.stringify(results)
  },
  {
    name: 'search_harvard_library',
    description:
      'Search Harvard Library Cloud catalog for academic books, articles, and resources. ' +
      'You can combine multiple search parameters (e.g., keyword + author, subject + title). ' +
      'All search fields support Boolean operators (AND, OR, NOT) to combine terms. ' +
      'Returns up to `limit` results sorted by relevance.',
    schema: z.object({
      keyword: z
        .string()
        .optional()
        .describe(
          'Keyword search across all fields. Use for general topic searches. Supports Boolean operators (AND, OR, NOT) to combine terms (e.g., "privacy AND surveillance").'
        ),
      author: z
        .string()
        .optional()
        .describe(
          'Search by author name. Use this to find works BY a specific person (e.g., "Jane Doe"). Supports Boolean operators (AND, OR, NOT) to combine multiple authors.'
        ),
      title: z
        .string()
        .optional()
        .describe(
          'Search by title. Use to find works with specific titles. Supports Boolean operators (AND, OR, NOT) to combine title terms.'
        ),
      subject: z
        .string()
        .optional()
        .describe(
          'Search by subject/topic. Use for topical searches (e.g., "artificial intelligence"). Supports Boolean operators (AND, OR, NOT) to combine subjects.'
        ),
      limit: z.number().default(10).describe('Maximum number of results to return (default 10, max 50)')
    })
  }
)
