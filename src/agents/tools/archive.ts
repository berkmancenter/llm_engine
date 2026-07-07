import fs from 'fs'
import path from 'path'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import rag from '../helpers/rag.js'
import logger from '../../config/logger.js'

/**
 * Tools that connect an agent to a BKC archive-wiki folder:
 *
 *  - search_archive            semantic search over the `archive-items` Chroma collection
 *                              (populated by src/utils/loadArchiveItems.ts)
 *  - list_archive_wiki_pages   the routing table: curated wiki pages by section
 *  - read_archive_wiki_page    read one wiki page; wiki-links expose archive item ids
 *  - get_archive_item          item stub + full source material (transcript / article text)
 *
 * The wiki layout this expects (see the archive-wiki README):
 *   topics/ people/ orgs/ timeline/   curated synthesis pages with YAML frontmatter
 *   items/<year>/<id>-<slug>.md       one stub per archive item
 *   collection/json/youtube.json      YouTube video metadata (ids like "yt_<videoId>")
 *   collection/txt/youtube/<id>.txt   full transcripts
 *   raw/archive.json                  all items; some carry full body text in `content`
 */

export const ARCHIVE_COLLECTION = 'archive-items'
export const ARCHIVE_COLLECTION_ID = 'bkc-archive'

const WIKI_SECTIONS = ['topics', 'people', 'orgs', 'timeline'] as const
const MAX_PAGE_CHARS = 8000
const MAX_SOURCE_CHARS = 12000
const SEARCH_RESULTS = 10
const SEARCH_SCORE_THRESHOLD = 0.8

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  let body = raw
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3)
    if (end !== -1) {
      const fm = raw.slice(3, end)
      body = raw.slice(end + 4).trim()
      for (const line of fm.split('\n')) {
        const m = line.match(/^([a-z_]+):\s*(.*)$/i)
        if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
      }
    }
  }
  return { meta, body }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[... truncated: ${text.length - max} more characters]`
}

// Lazy per-archivePath caches of the two JSON indexes, keyed by item id.
const archiveJsonCache = new Map<string, Map<string, Record<string, unknown>>>()
const youtubeJsonCache = new Map<string, Map<string, Record<string, unknown>>>()

function loadJsonItems(file: string): Record<string, unknown>[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Array.isArray(data) ? data : data.items || []
}

export function getArchiveJsonIndex(archivePath: string): Map<string, Record<string, unknown>> {
  let index = archiveJsonCache.get(archivePath)
  if (!index) {
    index = new Map()
    const file = path.join(archivePath, 'raw', 'archive.json')
    if (fs.existsSync(file)) {
      for (const item of loadJsonItems(file)) index.set(String(item.id), item)
    }
    archiveJsonCache.set(archivePath, index)
  }
  return index
}

export function getYoutubeIndex(archivePath: string): Map<string, Record<string, unknown>> {
  let index = youtubeJsonCache.get(archivePath)
  if (!index) {
    index = new Map()
    const file = path.join(archivePath, 'collection', 'json', 'youtube.json')
    if (fs.existsSync(file)) {
      for (const item of loadJsonItems(file)) index.set(String(item.id), item)
    }
    youtubeJsonCache.set(archivePath, index)
  }
  return index
}

export function getYoutubeTranscript(archivePath: string, id: string): string | null {
  const file = path.join(archivePath, 'collection', 'txt', 'youtube', `${id}.txt`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

function findItemStub(archivePath: string, id: string): string | null {
  const itemsDir = path.join(archivePath, 'items')
  if (!fs.existsSync(itemsDir)) return null
  for (const year of fs.readdirSync(itemsDir)) {
    const yearDir = path.join(itemsDir, year)
    if (!fs.statSync(yearDir).isDirectory()) continue
    for (const name of fs.readdirSync(yearDir)) {
      if (name.startsWith(`${id}-`) || name === `${id}.md`) return path.join(yearDir, name)
    }
  }
  return null
}

function findWikiPage(archivePath: string, slug: string, section?: string): string | null {
  const sections = section ? [section] : [...WIKI_SECTIONS]
  for (const s of sections) {
    const file = path.join(archivePath, s, `${slug}.md`)
    if (fs.existsSync(file)) return file
  }
  return null
}

export default function createArchiveTools(archivePath: string) {
  const searchArchiveTool = tool(
    async ({ query, kind }) => {
      const formatChunk = (doc) => {
        const m = doc.metadata || {}
        const bits = [m.title, m.date, m.source, m.url].filter(Boolean).join(' · ')
        return `[Archive item ${m.sourceId || '?'}${bits ? `: ${bits}` : ''}]\n${doc.pageContent}`
      }
      try {
        const { chunks } = await rag.getContextChunksForQuestion(
          ARCHIVE_COLLECTION,
          query,
          formatChunk,
          kind ? { kind } : undefined,
          SEARCH_RESULTS,
          undefined,
          undefined,
          SEARCH_SCORE_THRESHOLD
        )
        if (!chunks) return 'No relevant archive content found.'
        return chunks
      } catch (error) {
        logger.warn(`search_archive failed: ${error.message}`)
        return 'The archive index is not available. Has loadArchiveItems been run?'
      }
    },
    {
      name: 'search_archive',
      description:
        'Semantic search across the BKC archive: video transcripts, articles, and bookmarked item metadata. ' +
        'Use this for content questions about what the archive holds — what was said in a talk, coverage of a ' +
        'subject, writings by a person. Each result is prefixed with the archive item id and provenance ' +
        '(title, date, source, url) so you can cite it or drill in with get_archive_item.',
      schema: z.object({
        query: z.string().describe('The search query, e.g. "content moderation", "Zittrain on AI agents"'),
        kind: z
          .enum(['youtube-transcript', 'fulltext', 'bookmark'])
          .optional()
          .describe(
            'Limit results by item kind: youtube-transcript (video transcripts), fulltext (articles with body text), bookmark (title/description metadata only). Omit to search everything.'
          )
      })
    }
  )

  const listWikiPagesTool = tool(
    async ({ section }) => {
      const sections = section ? [section] : [...WIKI_SECTIONS]
      const lines: string[] = []
      for (const s of sections) {
        const dir = path.join(archivePath, s)
        if (!fs.existsSync(dir)) continue
        for (const name of fs.readdirSync(dir).sort()) {
          if (!name.endsWith('.md') || name.startsWith('_')) continue
          const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, name), 'utf8'))
          const slug = name.replace(/\.md$/, '')
          const extras = [
            meta.item_count ? `${meta.item_count} items` : null,
            meta.related ? `related: ${meta.related}` : null,
            meta.related_topics ? `topics: ${meta.related_topics}` : null,
            meta.affiliations ? `affiliations: ${meta.affiliations}` : null
          ]
            .filter(Boolean)
            .join(' | ')
          lines.push(`- [${s}] ${slug} — "${meta.title || slug}"${extras ? ` (${extras})` : ''}`)
        }
      }
      if (lines.length === 0) return 'No wiki pages found.'
      return lines.join('\n')
    },
    {
      name: 'list_archive_wiki_pages',
      description:
        'List the curated archive-wiki pages: thematic topic pages, people, organizations, and per-year timeline ' +
        'narratives. Use this first to route a question about a theme, person, org, or era to the right page, ' +
        'then call read_archive_wiki_page with the slug.',
      schema: z.object({
        section: z
          .enum([...WIKI_SECTIONS])
          .optional()
          .describe('Limit to one section: topics, people, orgs, or timeline. Omit to list all.')
      })
    }
  )

  const readWikiPageTool = tool(
    async ({ slug, section }) => {
      const file = findWikiPage(archivePath, slug, section)
      if (!file) {
        return `No wiki page found for slug "${slug}". Use list_archive_wiki_pages to see valid slugs.`
      }
      const raw = fs.readFileSync(file, 'utf8')
      return truncate(raw, MAX_PAGE_CHARS)
    },
    {
      name: 'read_archive_wiki_page',
      description:
        'Read one curated archive-wiki page by slug (from list_archive_wiki_pages). Pages link to archive items ' +
        'as wiki-links like [[<itemId>-<slug>|Title]] — pass that leading itemId (e.g. "17120704" or "yt_BSt010su3rU") ' +
        'to get_archive_item to retrieve the underlying source material.',
      schema: z.object({
        slug: z.string().describe('The page slug, e.g. "ai-governance-and-regulation" or "jonathan-zittrain"'),
        section: z
          .enum([...WIKI_SECTIONS])
          .optional()
          .describe('Which section the slug is in, if known. Omit to search all sections.')
      })
    }
  )

  const getArchiveItemTool = tool(
    async ({ id }) => {
      const parts: string[] = []

      const stubFile = findItemStub(archivePath, id)
      if (stubFile) parts.push(fs.readFileSync(stubFile, 'utf8').trim())

      if (id.startsWith('yt_')) {
        const meta = getYoutubeIndex(archivePath).get(id)
        if (meta && !stubFile) {
          parts.push(
            `# ${meta.title}\n**Video:** ${meta.url} · **Published:** ${String(meta.date_published || '').slice(
              0,
              10
            )}\n\n${stripHtml(String(meta.description || ''))}`
          )
        }
        const transcriptText = getYoutubeTranscript(archivePath, id)
        if (transcriptText) parts.push(`## Transcript\n\n${truncate(transcriptText, MAX_SOURCE_CHARS)}`)
      } else {
        const item = getArchiveJsonIndex(archivePath).get(id)
        if (item) {
          if (!stubFile) {
            parts.push(
              `# ${item.title}\n**URL:** ${item.url} · **Published:** ${String(item.date_published || '').slice(
                0,
                10
              )} · **Tags:** ${((item.tags as string[]) || []).join(', ')}\n\n${stripHtml(String(item.description || ''))}`
            )
          }
          const content = stripHtml(String(item.content || ''))
          if (content) parts.push(`## Full text\n\n${truncate(content, MAX_SOURCE_CHARS)}`)
        }
      }

      if (parts.length === 0) {
        return `No archive item found with id "${id}". Ids come from wiki-links ([[<id>-<slug>|...]]) or search_archive results.`
      }
      return parts.join('\n\n')
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
