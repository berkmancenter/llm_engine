import type { StructuredToolInterface } from '@langchain/core/tools'
import { registerTool, registerToolPrompt, getTools, buildToolsGuidance, listRegisteredTools } from '../../../src/agents/tools/registry.js'
import { buildWebSearchPrompt } from '../../../src/agents/tools/webSearch.js'

describe('Tool Registry', () => {
  test('should have built-in tools registered', () => {
    const registered = listRegisteredTools()
    expect(registered).toContain('tavily_search')
    expect(registered).toContain('web_search')
    expect(registered).toContain('search_semantic_scholar')
    expect(registered).toContain('get_semantic_scholar_recommendations')
    expect(registered).toContain('event_history')
    expect(registered).toContain('bkc_archive_wiki')
  })

  test('should resolve web_search to tool instance', async () => {
    const tools = await getTools(['web_search'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  test('should resolve tavily_search alias to web_search tool', async () => {
    const tools = await getTools(['tavily_search'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  test('should resolve multiple tools at once', async () => {
    const tools = await getTools(['web_search', 'search_semantic_scholar'])
    expect(tools).toHaveLength(2)
    const names = tools.map((t) => t.name)
    expect(names).toContain('web_search')
    expect(names).toContain('search_semantic_scholar')
  })

  test('should skip unknown tool names with a warning', async () => {
    const tools = await getTools(['web_search', 'nonexistent_tool'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('web_search')
  })

  test('should return empty array for all unknown names', async () => {
    const tools = await getTools(['does_not_exist', 'also_missing'])
    expect(tools).toHaveLength(0)
  })

  test('should return empty array for empty input', async () => {
    const tools = await getTools([])
    expect(tools).toHaveLength(0)
  })

  test('should support custom tool registration', async () => {
    const mockTool = { name: 'custom_test_tool' } as unknown as StructuredToolInterface
    registerTool('custom_test_tool', () => mockTool)

    const tools = await getTools(['custom_test_tool'])
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('custom_test_tool')
  })

  test('should pass context to factory functions', async () => {
    let receivedContext: Record<string, unknown> | null = null
    registerTool('context_test_tool', (ctx) => {
      receivedContext = ctx ?? null
      return { name: 'context_test_tool' } as unknown as StructuredToolInterface
    })

    await getTools(['context_test_tool'], { myParam: 'hello' })
    expect(receivedContext).toEqual({ myParam: 'hello' })
  })

  test('event_history factory should return empty array without topics context', async () => {
    const tools = await getTools(['event_history'])
    expect(tools).toHaveLength(0)
  })

  test('buildToolsGuidance returns empty string for tools with no registered prompt', async () => {
    const guidance = await buildToolsGuidance(['search_semantic_scholar'])
    expect(guidance).toBe('')
  })

  test('buildToolsGuidance returns web_search prompt for web_search', async () => {
    const guidance = await buildToolsGuidance(['web_search'])
    expect(guidance).toContain(buildWebSearchPrompt())
  })

  test('buildToolsGuidance skips unknown tool names silently', async () => {
    const guidance = await buildToolsGuidance(['nonexistent_tool'])
    expect(guidance).toBe('')
  })

  test('buildToolsGuidance supports custom prompt registration', async () => {
    registerToolPrompt('custom_prompt_tool', () => '**Custom guidance**')
    const guidance = await buildToolsGuidance(['custom_prompt_tool'])
    expect(guidance).toContain('**Custom guidance**')
  })

  test('event_history factory returns the three tools when topics are provided', async () => {
    const tools = await getTools(['event_history'], { topics: [{ id: '507f1f77bcf86cd799439011', name: 'My Series' }] })
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining(['get_event_list', 'search_topic_transcripts', 'search_conversation_transcript'])
    )
  })

  test('event_history factory accepts activeConversationId context without error', async () => {
    const tools = await getTools(['event_history'], {
      topics: [{ id: '507f1f77bcf86cd799439011', name: 'My Series' }],
      activeConversationId: '507f1f77bcf86cd799439012'
    })
    expect(tools).toHaveLength(3)
  })
})
