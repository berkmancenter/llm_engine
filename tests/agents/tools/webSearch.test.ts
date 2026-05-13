import { searchWeb, registerWebSearchProvider } from '../../../src/agents/tools/webSearch.js'
import type { WebSearchResult, WebSearchParams } from '../../../src/agents/tools/webSearch.js'

describe('Web Search Abstraction', () => {
  test('searchWeb delegates to the configured provider', async () => {
    const mockResults: WebSearchResult[] = [
      { title: 'Test', url: 'https://example.com', content: 'snippet', score: 0.9 }
    ]
    const mockProvider = jest.fn<Promise<WebSearchResult[]>, [WebSearchParams]>().mockResolvedValue(mockResults)

    registerWebSearchProvider('test_provider', () => mockProvider)

    // Temporarily override the config to use our test provider
    const config = (await import('../../../src/config/config.js')).default
    const original = config.webSearchProvider
    config.webSearchProvider = 'test_provider'

    try {
      const results = await searchWeb({ query: 'hello world', maxResults: 3 })
      expect(results).toEqual(mockResults)
      expect(mockProvider).toHaveBeenCalledWith({
        query: 'hello world',
        maxResults: 3
      })
    } finally {
      config.webSearchProvider = original
    }
  })

  test('searchWeb returns empty array for unknown provider', async () => {
    const config = (await import('../../../src/config/config.js')).default
    const original = config.webSearchProvider
    config.webSearchProvider = 'nonexistent_provider'

    try {
      const results = await searchWeb({ query: 'test' })
      expect(results).toEqual([])
    } finally {
      config.webSearchProvider = original
    }
  })

  test('tavily provider is registered by default', async () => {
    const config = (await import('../../../src/config/config.js')).default
    expect(config.webSearchProvider).toBe('tavily')
  })
})
