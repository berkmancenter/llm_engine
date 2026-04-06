import { searchLibrary } from '../../../src/agents/tools/searchHarvardLibrary.js'

describe('Harvard Library API', () => {
  const mockApiUrl = 'https://api.example.com/test'

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('searchLibrary', () => {
    it('handles API response with multiple results (array)', async () => {
      const mockResponse = {
        items: {
          mods: [
            {
              titleInfo: { title: 'Book 1' },
              name: [
                {
                  namePart: 'Author One',
                  role: { roleTerm: 'author' }
                }
              ],
              originInfo: { dateIssued: '2020' }
            },
            {
              titleInfo: { title: 'Book 2' },
              name: [
                {
                  namePart: 'Author Two',
                  role: { roleTerm: 'author' }
                }
              ],
              originInfo: { dateIssued: '2021' }
            }
          ]
        },
        pagination: { numFound: 2 }
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(2)
      expect(results[0].title).toBe('Book 1')
      expect(results[0].authors).toEqual(['Author One'])
      expect(results[0].year).toBe(2020)
      expect(results[1].title).toBe('Book 2')
      expect(results[1].authors).toEqual(['Author Two'])
      expect(results[1].year).toBe(2021)
    })

    it('handles API response with single result (object, not array)', async () => {
      const mockResponse = {
        items: {
          mods: {
            titleInfo: { title: 'Single Book' },
            name: [
              {
                namePart: 'Single Author',
                role: { roleTerm: 'author' }
              }
            ],
            originInfo: { dateIssued: '2022' }
          }
        },
        pagination: { numFound: 1 }
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('Single Book')
      expect(results[0].authors).toEqual(['Single Author'])
      expect(results[0].year).toBe(2022)
    })

    it('handles API response with no results (numFound=0)', async () => {
      const mockResponse = {
        pagination: { numFound: 0 }
        // No items field when numFound=0
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'nonexistent' }, mockApiUrl)

      expect(results).toHaveLength(0)
    })

    it('handles missing items field gracefully', async () => {
      const mockResponse = {
        pagination: { numFound: 5 }
        // items field missing (unexpected but should handle gracefully)
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(0)
    })

    it('handles API error responses', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(0)
    })

    it('handles network timeout', async () => {
      global.fetch = jest.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => {
              const error = new Error('The operation was aborted')
              error.name = 'AbortError'
              reject(error)
            }, 100)
          })
      )

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(0)
    })

    it('handles network errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'))

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(0)
    })

    it('filters out items with no title', async () => {
      const mockResponse = {
        items: {
          mods: [
            {
              titleInfo: { title: 'Valid Book' },
              name: [
                {
                  namePart: 'Author',
                  role: { roleTerm: 'author' }
                }
              ],
              originInfo: { dateIssued: '2020' }
            },
            {
              // Missing titleInfo - should be filtered out
              name: [
                {
                  namePart: 'Author',
                  role: { roleTerm: 'author' }
                }
              ]
            }
          ]
        },
        pagination: { numFound: 2 }
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('Valid Book')
    })

    it('constructs correct search URLs with different parameters', async () => {
      const mockResponse = {
        items: { mods: [] },
        pagination: { numFound: 0 }
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      await searchLibrary(
        {
          keyword: 'privacy',
          author: 'Jane Doe',
          subject: 'surveillance',
          title: 'Data',
          limit: 20
        },
        mockApiUrl
      )

      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('q=privacy'), expect.anything())
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('name=Jane+Doe'), expect.anything())
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('subject=surveillance'), expect.anything())
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('title=Data'), expect.anything())
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('limit=20'), expect.anything())
    })

    it('handles complex author data structures', async () => {
      const mockResponse = {
        items: {
          mods: {
            titleInfo: { title: 'Complex Author Book' },
            name: [
              {
                namePart: [
                  { '#text': 'Smith, John', '@type': 'personal' },
                  { '#text': '1950-', '@type': 'date' }
                ],
                role: { roleTerm: 'creator' }
              }
            ],
            originInfo: { dateIssued: '2023' }
          }
        },
        pagination: { numFound: 1 }
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(1)
      expect(results[0].authors).toEqual(['Smith, John'])
    })

    it('handles missing authors gracefully', async () => {
      const mockResponse = {
        items: {
          mods: {
            titleInfo: { title: 'No Author Book' },
            // No name field
            originInfo: { dateIssued: '2023' }
          }
        },
        pagination: { numFound: 1 }
      }

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      } as Response)

      const results = await searchLibrary({ keyword: 'test' }, mockApiUrl)

      expect(results).toHaveLength(1)
      expect(results[0].authors).toEqual(['Unknown'])
    })
  })
})
