import config from '../../config/config.js'

/**
 * Default `agentConfig.tools` for Event Assistant / Voice Assistant.
 * Include `web_search` only when the configured web search backend can run (Tavily + API key).
 */
export default function getDefaultEventAssistantToolNames(): string[] {
  const provider = (config.webSearchProvider || 'tavily').toLowerCase()
  const apiKey = typeof config.tavily?.apiKey === 'string' ? config.tavily.apiKey.trim() : ''
  if (provider === 'tavily' && apiKey.length > 0) {
    return ['web_search']
  }
  return []
}
