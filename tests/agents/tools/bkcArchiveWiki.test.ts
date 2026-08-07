/* eslint-disable no-console */
import { bkcArchiveWikiTools } from '../../../src/agents/tools/bkcArchiveWiki.js'

jest.setTimeout(20000)

describe('BKC Archive Wiki Tools Integration', () => {
  const hasApiUrl = !!process.env.BKC_ARCHIVE_API_URL

  ;(hasApiUrl ? describe : describe.skip)('archive tools (requires BKC_ARCHIVE_API_URL)', () => {
    let searchTool
    let listPagesTool
    let readPageTool
    let getItemTool

    beforeAll(() => {
      expect(bkcArchiveWikiTools).toHaveLength(4)
      ;[searchTool, listPagesTool, readPageTool, getItemTool] = bkcArchiveWikiTools
    })

    describe('search_archive', () => {
      test('returns results for a basic query', async () => {
        const result = await searchTool.invoke({ query: 'internet governance' })
        console.log('search_archive (internet governance):', result)

        expect(typeof result).toBe('string')
        expect(result).not.toBe('The archive is not reachable right now. Answer from other sources or try again later.')
        expect(result).not.toBe('No relevant archive content found.')
      })

      test('returns a no-results message for a nonsense query', async () => {
        const result = await searchTool.invoke({ query: 'xyzzy123nonsense987qwerty' })
        console.log('search_archive (nonsense query):', result)

        expect(typeof result).toBe('string')
        expect(result).toBe('No relevant archive content found.')
      })

      test('accepts an optional section filter', async () => {
        const result = await searchTool.invoke({ query: 'privacy', section: 'topics' })
        console.log('search_archive (privacy, topics):', result)

        expect(typeof result).toBe('string')
      })

      test('throws on invalid section filter', async () => {
        await expect(searchTool.invoke({ query: 'privacy', section: 'sandwiches' })).rejects.toThrow()
      })
    })

    describe('list_archive_wiki_pages', () => {
      test('lists pages without a section filter', async () => {
        const result = await listPagesTool.invoke({})
        console.log('list_archive_wiki_pages (all):', result)

        expect(typeof result).toBe('string')
        expect(result).not.toBe('The archive is not reachable right now. Answer from other sources or try again later.')
        expect(result).not.toBe('No wiki pages found.')
      })

      test('lists pages for a specific section', async () => {
        const result = await listPagesTool.invoke({ section: 'topics' })
        console.log('list_archive_wiki_pages (topics):', result)

        expect(typeof result).toBe('string')
        expect(result).not.toBe('No wiki pages found.')
      })

      test('throws on invalid section filter', async () => {
        await expect(listPagesTool.invoke({ section: 'sandwiches' })).rejects.toThrow()
      })
    })

    describe('read_archive_wiki_page', () => {
      test('returns a not-found message for an unknown slug', async () => {
        const result = await readPageTool.invoke({ slug: 'this-slug-does-not-exist-xyzzy' })
        console.log('read_archive_wiki_page (unknown slug):', result)

        expect(typeof result).toBe('string')
        expect(result).toContain('No wiki page found')
      })
      test('returns a wiki page with a known slug', async () => {
        const result = await readPageTool.invoke({ slug: 'jonathan-zittrain' })
        console.log('read_archive_wiki_page (known slug):', result)

        expect(typeof result).toBe('string')
        expect(result).not.toContain('No wiki page found')
      })
    })

    describe('get_archive_item', () => {
      test('returns a not-found message for an unknown id', async () => {
        const result = await getItemTool.invoke({ id: 'nonexistent-item-id-xyzzy' })
        console.log('get_archive_item (unknown id):', result)

        expect(typeof result).toBe('string')
        expect(result).toContain('No archive item found')
      })
      test('returns a result for known id', async () => {
        const result = await getItemTool.invoke({ id: '2461702' })
        console.log('get_archive_item (known id):', result)

        expect(typeof result).toBe('string')
        expect(result).not.toContain('No archive item found')
      })
    })
  })
  ;(!hasApiUrl ? describe : describe.skip)('archive tools (no BKC_ARCHIVE_API_URL)', () => {
    test('bkcArchiveWikiTools is an empty array', () => {
      expect(bkcArchiveWikiTools).toEqual([])
    })
  })
})
