import {
  buildSeriesHistoryRules,
  buildEventAssistantToolSystemPrompt,
  EVENT_ASSISTANT_TOOL_USAGE_RULES,
  EVENT_ASSISTANT_SERIES_HISTORY_USER_CARVEOUT
} from '../../../src/agents/eventAssistant/buildEventAssistantToolSystemPrompt.js'

describe('series history guidance', () => {
  describe('buildSeriesHistoryRules', () => {
    test('names the series and the three event_history tools', () => {
      const rules = buildSeriesHistoryRules('AI Ethics Salon')
      expect(rules).toContain('AI Ethics Salon')
      expect(rules).toMatch(/get_event_list/)
      expect(rules).toMatch(/search_topic_transcripts/)
      expect(rules).toMatch(/search_conversation_transcript/)
    })

    test('scopes the search to OTHER past events, not the current one', () => {
      const rules = buildSeriesHistoryRules('Weekly Standup')
      expect(rules).toMatch(/other past events|other events/i)
      expect(rules).toMatch(/current event.*already in your Context/i)
    })

    test('routes series questions to these tools rather than web_search', () => {
      const rules = buildSeriesHistoryRules('Weekly Standup')
      expect(rules).toMatch(/not.*on the public web/i)
      expect(rules).toMatch(/web_search.{0,3}cannot answer/i)
    })
  })

  describe('EVENT_ASSISTANT_SERIES_HISTORY_USER_CARVEOUT', () => {
    test('tells the model to use event-history tools, not web_search, for prior-event questions', () => {
      expect(EVENT_ASSISTANT_SERIES_HISTORY_USER_CARVEOUT).toMatch(/Series-history exception/i)
      expect(EVENT_ASSISTANT_SERIES_HISTORY_USER_CARVEOUT).toMatch(/NOT `?web_search`?/)
      expect(EVENT_ASSISTANT_SERIES_HISTORY_USER_CARVEOUT).toMatch(/wider world/i)
    })
  })

  describe('buildEventAssistantToolSystemPrompt gating', () => {
    const base = 'BASE_SYSTEM_TEMPLATE'
    const topic = 'Test topic'
    const ctx = 'CONTEXT_CHUNKS'

    test('includes series history rules when a series is provided', () => {
      const full = buildEventAssistantToolSystemPrompt(base, topic, ctx, {
        hasWebSearch: false,
        series: { name: 'My Series' }
      })
      expect(full).toContain('My Series')
      expect(full).toMatch(/search_topic_transcripts/)
    })

    test('omits web-search rules when hasWebSearch is false', () => {
      const full = buildEventAssistantToolSystemPrompt(base, topic, ctx, {
        hasWebSearch: false,
        series: { name: 'My Series' }
      })
      expect(full).not.toContain(EVENT_ASSISTANT_TOOL_USAGE_RULES)
    })

    test('includes both rule blocks when web search and series are both active', () => {
      const full = buildEventAssistantToolSystemPrompt(base, topic, ctx, {
        hasWebSearch: true,
        series: { name: 'My Series' }
      })
      expect(full).toContain(EVENT_ASSISTANT_TOOL_USAGE_RULES)
      expect(full).toContain('My Series')
      // systemTemplate first, then rules, then context
      expect(full.startsWith(base)).toBe(true)
      expect(full.indexOf('My Series')).toBeLessThan(full.indexOf(ctx))
    })

    test('omits series rules when no series is provided (web-search-only path unchanged)', () => {
      const full = buildEventAssistantToolSystemPrompt(base, topic, ctx, { hasWebSearch: true })
      expect(full).toContain(EVENT_ASSISTANT_TOOL_USAGE_RULES)
      expect(full).not.toMatch(/Event series history tools/)
    })
  })
})
