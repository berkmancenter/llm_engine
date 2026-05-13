import config from '../../../src/config/config.js'
import getDefaultEventAssistantToolNames from '../../../src/agents/eventAssistant/eventAssistantDefaultTools.js'

describe('getDefaultEventAssistantToolNames', () => {
  let origProvider: string
  let origApiKey: string | undefined

  beforeEach(() => {
    origProvider = config.webSearchProvider
    origApiKey = config.tavily.apiKey
  })

  afterEach(() => {
    config.webSearchProvider = origProvider
    config.tavily.apiKey = origApiKey
  })

  test('returns web_search when provider is tavily and API key is non-empty', () => {
    config.webSearchProvider = 'tavily'
    config.tavily.apiKey = 'tvly-test-key'
    expect(getDefaultEventAssistantToolNames()).toEqual(['web_search'])
  })

  test('returns web_search when provider is Tavily with mixed case', () => {
    config.webSearchProvider = 'Tavily'
    config.tavily.apiKey = 'abc'
    expect(getDefaultEventAssistantToolNames()).toEqual(['web_search'])
  })

  test('returns empty array when Tavily key is missing or whitespace', () => {
    config.webSearchProvider = 'tavily'
    config.tavily.apiKey = ''
    expect(getDefaultEventAssistantToolNames()).toEqual([])

    config.tavily.apiKey = '   \t  '
    expect(getDefaultEventAssistantToolNames()).toEqual([])

    config.tavily.apiKey = undefined as unknown as string
    expect(getDefaultEventAssistantToolNames()).toEqual([])
  })

  test('returns empty array when provider is not tavily even if key is set', () => {
    config.webSearchProvider = 'brave'
    config.tavily.apiKey = 'tvly-test-key'
    expect(getDefaultEventAssistantToolNames()).toEqual([])
  })
})
