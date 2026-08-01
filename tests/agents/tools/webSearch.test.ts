import {
  searchWeb,
  registerWebSearchProvider,
  createWebSearchTool,
  webSearchTool
} from '../../../src/agents/tools/webSearch.js'
import type { WebSearchResult, WebSearchParams } from '../../../src/agents/tools/webSearch.js'

describe('Web Search Abstraction', () => {
  test('searchWeb delegates to the configured provider', async () => {
    const mockResults: WebSearchResult[] = [{ title: 'Test', url: 'https://example.com', content: 'snippet', score: 0.9 }]
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

describe('createWebSearchTool', () => {
  test('defaults maxResults to 5 when no config is given', () => {
    const t = createWebSearchTool()
    const parsed = t.schema.parse({ query: 'x' })
    expect(parsed.maxResults).toBe(5)
  })

  test('applies a config override as the schema default', () => {
    const t = createWebSearchTool({ maxResults: 3 })
    const parsed = t.schema.parse({ query: 'x' })
    expect(parsed.maxResults).toBe(3)
  })

  test('an explicit per-call maxResults still overrides the config default', () => {
    const t = createWebSearchTool({ maxResults: 3 })
    const parsed = t.schema.parse({ query: 'x', maxResults: 12 })
    expect(parsed.maxResults).toBe(12)
  })

  test('webSearchTool is the no-config default instance', () => {
    expect(webSearchTool.name).toBe('web_search')
    const parsed = webSearchTool.schema.parse({ query: 'x' })
    expect(parsed.maxResults).toBe(5)
  })
})
