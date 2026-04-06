import { searchLibrary } from '../../../src/agents/tools/searchHarvardLibrary.js'
import config from '../../../src/config/config.js'

describe('Harvard Library API Integration', () => {
  // Use real API for integration testing
  const apiUrl = config.harvardLibrary.baseUrl

  describe('searchLibrary', () => {
    test('should search by keyword and return valid results', async () => {
      const results = await searchLibrary({ keyword: 'artificial intelligence', limit: 5 }, apiUrl)

      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(5)

      // Check first result has required fields
      const firstResult = results[0]
      expect(firstResult).toHaveProperty('title')
      expect(firstResult).toHaveProperty('authors')
      expect(firstResult.title).toBeTruthy()
      expect(Array.isArray(firstResult.authors)).toBe(true)
      expect(firstResult.authors.length).toBeGreaterThan(0)
    })

    test('should search by author and return valid results', async () => {
      const results = await searchLibrary({ author: 'Shakespeare', limit: 3 }, apiUrl)

      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.length).toBeLessThanOrEqual(3)

      const firstResult = results[0]
      expect(firstResult.title).toBeTruthy()
      expect(firstResult.authors).toBeDefined()
    })

    test('should search by title and return valid results', async () => {
      const results = await searchLibrary({ title: 'machine learning', limit: 3 }, apiUrl)

      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
    })

    test('should search by subject and return valid results', async () => {
      const results = await searchLibrary({ subject: 'climate change', limit: 3 }, apiUrl)

      expect(results).toBeDefined()
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })

    test('should include optional fields when available', async () => {
      const results = await searchLibrary({ keyword: 'peanuts', limit: 10 }, apiUrl)

      expect(results.length).toBeGreaterThan(0)

      // At least some results should have these optional fields
      const hasYear = results.some((r) => r.year !== undefined)
      const hasAbstract = results.some((r) => r.abstract !== undefined)
      const hasSubjects = results.some((r) => r.subjects !== undefined)
      const hasPublisher = results.some((r) => r.publisher !== undefined)
      const hasLanguage = results.some((r) => r.language !== undefined)
      const hasResourceType = results.some((r) => r.resourceType !== undefined)

      expect(hasYear).toBe(true)
      expect(hasAbstract).toBe(true)
      expect(hasSubjects).toBe(true)
      expect(hasPublisher).toBe(true)
      expect(hasLanguage).toBe(true)
      expect(hasResourceType).toBe(true)
    })

    test('should extract subjects correctly', async () => {
      const results = await searchLibrary({ keyword: 'peanut butter', limit: 5 }, apiUrl)

      const resultsWithSubjects = results.filter((r) => r.subjects && r.subjects.length > 0)
      expect(resultsWithSubjects.length).toBeGreaterThan(0)

      const firstWithSubjects = resultsWithSubjects[0]
      expect(Array.isArray(firstWithSubjects.subjects)).toBe(true)
      expect(firstWithSubjects.subjects!.length).toBeGreaterThan(0)
      expect(typeof firstWithSubjects.subjects![0]).toBe('string')
    })

    test('should extract authors correctly', async () => {
      const results = await searchLibrary({ keyword: 'peanuts', limit: 5 }, apiUrl)

      expect(results.length).toBeGreaterThan(0)

      results.forEach((result) => {
        expect(Array.isArray(result.authors)).toBe(true)
        expect(result.authors.length).toBeGreaterThan(0)
        result.authors.forEach((author) => {
          expect(typeof author).toBe('string')
          expect(author.length).toBeGreaterThan(0)
        })
      })
    })

    test('should extract year as a number when available', async () => {
      const results = await searchLibrary({ keyword: 'peanuts', limit: 10 }, apiUrl)

      const resultsWithYear = results.filter((r) => r.year !== undefined)
      expect(resultsWithYear.length).toBeGreaterThan(0)

      resultsWithYear.forEach((result) => {
        expect(typeof result.year).toBe('number')
        expect(result.year).toBeGreaterThan(1000)
        expect(result.year).toBeLessThan(3000)
      })
    })

    test('should truncate abstract to 300 characters', async () => {
      const results = await searchLibrary({ keyword: 'peanut butter history', limit: 10 }, apiUrl)

      const resultsWithAbstract = results.filter((r) => r.abstract !== undefined)
      expect(resultsWithAbstract.length).toBeGreaterThan(0)

      resultsWithAbstract.forEach((result) => {
        expect(result.abstract!.length).toBeLessThanOrEqual(300)
      })
    })

    test('should not include id or url fields', async () => {
      const results = await searchLibrary({ keyword: 'peanuts', limit: 5 }, apiUrl)

      expect(results.length).toBeGreaterThan(0)

      results.forEach((result) => {
        expect(result).not.toHaveProperty('id')
        expect(result).not.toHaveProperty('url')
      })
    })

    test('should return empty array for query with no results', async () => {
      const results = await searchLibrary({ keyword: 'xyzqwertyuiopasdfghjklzxcvbnm123456789', limit: 5 }, apiUrl)

      expect(Array.isArray(results)).toBe(true)
      expect(results).toHaveLength(0)
    })

    test('should handle API errors gracefully', async () => {
      const results = await searchLibrary({ keyword: 'test', limit: 5 }, 'https://invalid-url-that-does-not-exist.com')

      expect(Array.isArray(results)).toBe(true)
      expect(results).toHaveLength(0)
    })

    test('should handle numFound=0 gracefully', async () => {
      // Query that should return zero results
      const results = await searchLibrary({ keyword: 'xyzabc123nonexistentquery999', limit: 5 }, apiUrl)

      expect(Array.isArray(results)).toBe(true)
      expect(results).toHaveLength(0)
    })
  })
})
