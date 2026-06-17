import type { StructuredToolInterface } from '@langchain/core/tools'
import { registerTool, getTools, listRegisteredTools } from '../../../src/agents/tools/registry.js'

describe('Tool Registry', () => {
  test('should have built-in tools registered', () => {
    const registered = listRegisteredTools()
    expect(registered).toContain('tavily_search')
    expect(registered).toContain('web_search')
    expect(registered).toContain('search_semantic_scholar')
    expect(registered).toContain('get_semantic_scholar_recommendations')
    expect(registered).toContain('event_history')
  })

  test('should resolve web_search to tool instance', () => {
    const tools = getTools(['web_search'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  test('should resolve tavily_search alias to web_search tool', () => {
    const tools = getTools(['tavily_search'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  test('should resolve multiple tools at once', () => {
    const tools = getTools(['web_search', 'search_semantic_scholar'])
    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('search_semantic_scholar')
  })

  test('should skip unknown tool names with a warning', () => {
    const tools = getTools(['web_search', 'nonexistent_tool'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  test('should return empty array for all unknown names', () => {
    const tools = getTools(['does_not_exist', 'also_missing'])
    expect(tools).toHaveLength(0)
  })

  test('should return empty array for empty input', () => {
    const tools = getTools([])
    expect(tools).toHaveLength(0)
  })

  test('should support custom tool registration', () => {
    const mockTool = { name: 'custom_test_tool' } as unknown as StructuredToolInterface
    registerTool('custom_test_tool', () => mockTool)

    const tools = getTools(['custom_test_tool'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('custom_test_tool')
  })

  test('should pass context to factory functions', () => {
    let receivedContext: Record<string, unknown> | null = null
    registerTool('context_test_tool', (ctx) => {
      receivedContext = ctx ?? null
      return { name: 'context_test_tool' } as unknown as StructuredToolInterface
    })

    getTools(['context_test_tool'], { myParam: 'hello' })
    expect(receivedContext).toEqual({ myParam: 'hello' })
  })

  test('event_history factory should return empty array without topics context', () => {
    const tools = getTools(['event_history'])
    expect(tools).toHaveLength(0)
  })

  test('event_history factory returns the three tools when topics are provided', () => {
    const tools = getTools(['event_history'], { topics: [{ id: '507f1f77bcf86cd799439011', name: 'My Series' }] })
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['get_event_list', 'search_topic_transcripts', 'search_conversation_transcript'])
    )
  })

  test('event_history factory accepts excludeConversationId context without error', () => {
    const tools = getTools(['event_history'], {
      topics: [{ id: '507f1f77bcf86cd799439011', name: 'My Series' }],
      excludeConversationId: '507f1f77bcf86cd799439012'
    })
    expect(tools).toHaveLength(3)
  })
})
