import { getRecommendations, searchPapers } from '../../../src/agents/tools/semanticScholar.js'

jest.setTimeout(20000) // Increase timeout for API calls

describe('Semantic Scholar API Integration', () => {
  describe('searchPapers', () => {
    test('should find papers by keyword query', async () => {
      const results = await searchPapers({ query: 'artificial intelligence law regulation', limit: 5 })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
      expect(results[0]).toHaveProperty('paperId')
    })

    test('should find papers by author name', async () => {
      const results = await searchPapers({ query: 'Ryan Calo', limit: 5 })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })

    test('should return requested fields', async () => {
      const results = await searchPapers({
        query: 'data privacy technology law',
        fields: ['paperId', 'title', 'year', 'citationCount'],
        limit: 5
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
      results.forEach((paper) => {
        expect(paper).toHaveProperty('paperId')
        expect(paper).toHaveProperty('title')
      })
    })

    test('should respect the limit parameter', async () => {
      const results = await searchPapers({
        query: 'algorithmic accountability law',
        limit: 3
      })

      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(3)
    })
  })

  describe('getRecommendations', () => {
    beforeAll(() => jest.setTimeout(60000))

    // Seed paper resolved dynamically from a search so we know it has a valid publicationType
    let seedPaperId: string

    beforeAll(async () => {
      const papers = await searchPapers({ query: 'artificial intelligence regulation law', limit: 5 })
      expect(papers.length).toBeGreaterThan(0)
      seedPaperId = papers[0].paperId!
    })

    test('should return recommendations for a paper given by ID', async () => {
      const results = await getRecommendations({
        positivePapers: [{ paperId: seedPaperId }],
        limit: 5
      })

      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    test('should return requested fields on each result', async () => {
      const results = await getRecommendations({
        positivePapers: [{ paperId: seedPaperId }],
        fields: ['paperId', 'title', 'year', 'citationCount'],
        limit: 5
      })

      expect(results.length).toBeGreaterThan(0)

      results.forEach((paper) => {
        expect(paper).toHaveProperty('paperId')
        expect(paper).toHaveProperty('title')
      })
    })

    test('should sort results by citationCount descending', async () => {
      const results = await getRecommendations({
        positivePapers: [{ paperId: seedPaperId }],
        fields: ['paperId', 'title', 'citationCount'],
        limit: 10,
        sortBy: 'citationCount',
        sortOrder: 'desc'
      })

      expect(results.length).toBeGreaterThan(1)

      const counts = results.map((p) => p.citationCount).filter((c): c is number => typeof c === 'number')

      for (let i = 1; i < counts.length; i++) {
        expect(counts[i - 1]).toBeGreaterThanOrEqual(counts[i])
      }
    })

    test('should sort results by year ascending', async () => {
      const results = await getRecommendations({
        positivePapers: [{ paperId: seedPaperId }],
        fields: ['paperId', 'title', 'year'],
        limit: 10,
        sortBy: 'year',
        sortOrder: 'asc'
      })

      expect(results.length).toBeGreaterThan(1)

      const years = results.map((p) => p.year).filter((y): y is number => typeof y === 'number')

      for (let i = 1; i < years.length; i++) {
        expect(years[i]).toBeGreaterThanOrEqual(years[i - 1])
      }
    })

    test('should accept negative papers to refine recommendations', async () => {
      const results = await getRecommendations({
        positivePapers: [{ paperId: seedPaperId }],
        negativePapers: [{ paperId: 'df2b0e28dde8f7f5a9f3d17b3a3d3e0f6c2a3b5c' }],
        limit: 5
      })

      expect(Array.isArray(results)).toBe(true)
      // Just verify the call succeeds — negative papers affect ranking, not necessarily count
    })
  })
})
