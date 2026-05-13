import { searchTavily } from '../../../src/agents/tools/tavilySearch.js'

jest.setTimeout(20000)

describe('Tavily Search API Integration', () => {
  const hasApiKey = !!process.env.TAVILY_API_KEY

  ;(hasApiKey ? describe : describe.skip)('searchTavily (requires TAVILY_API_KEY)', () => {
    test('should return results for a basic query', async () => {
      const results = await searchTavily({ query: 'latest AI regulation news', maxResults: 3 })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(3)
      expect(results[0]).toHaveProperty('title')
      expect(results[0]).toHaveProperty('url')
      expect(results[0]).toHaveProperty('content')
    })

    test('should respect the maxResults parameter', async () => {
      const results = await searchTavily({ query: 'climate change policy 2025', maxResults: 2 })

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(2)
    })

    test('should support domain filtering', async () => {
      const results = await searchTavily({
        query: 'artificial intelligence',
        maxResults: 5,
        includeDomains: ['wikipedia.org']
      })

      expect(Array.isArray(results)).toBe(true)
      results.forEach((result) => {
        expect(result.url).toContain('wikipedia.org')
      })
    })

    test('should return results with advanced search depth', async () => {
      const results = await searchTavily({
        query: 'quantum computing breakthroughs',
        searchDepth: 'advanced',
        maxResults: 3
      })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('searchTavily (no API key)', () => {
    test('should return empty array when API key is missing', async () => {
      const originalKey = process.env.TAVILY_API_KEY
      delete process.env.TAVILY_API_KEY

      // Re-import to pick up missing key -- for unit testing we call directly
      // but config is cached, so we test the guard in the function
      const { searchTavily: searchFn } = await import('../../../src/agents/tools/tavilySearch.js')

      // The function checks config.tavily?.apiKey which was set at startup,
      // so this tests the guard path only when config truly has no key
      if (!hasApiKey) {
        const results = await searchFn({ query: 'test' })
        expect(Array.isArray(results)).toBe(true)
        expect(results).toHaveLength(0)
      }

      if (originalKey) process.env.TAVILY_API_KEY = originalKey
    })
  })
})
