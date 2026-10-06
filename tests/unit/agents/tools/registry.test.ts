import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  registerTool,
  registerToolPrompt,
  getTools,
  buildToolsGuidance,
  listRegisteredTools
} from '../../../../src/agents/tools/registry.js'
import { buildWebSearchPrompt } from '../../../../src/agents/tools/webSearch.js'
import setupIntTest from '../../../utils/setupIntTest.js'
import { createUser, createPublicTopic, createConversation } from '../../../utils/agentTestHelpers.js'

setupIntTest()

describe('Tool Registry', () => {
  test('should have built-in tools registered', () => {
    const registered = listRegisteredTools()
    expect(registered).toContain('tavily_search')
    expect(registered).toContain('web_search')
    expect(registered).toContain('search_semantic_scholar')
    expect(registered).toContain('get_semantic_scholar_recommendations')
    expect(registered).toContain('event_history')
    expect(registered).toContain('bkc_archive_wiki')
    expect(registered).toContain('member_bios')
    expect(registered).toContain('resource_search')
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

  test('member_bios factory returns search_members and get_member when activeConversationId is provided', async () => {
    const tools = await getTools(['member_bios'], { activeConversationId: '507f1f77bcf86cd799439012' })
    expect(tools.map((t) => t.name)).toEqual(['search_members', 'get_member'])
  })

  test('member_bios factory returns empty array without activeConversationId in context', async () => {
    const tools = await getTools(['member_bios'], {})
    expect(tools).toHaveLength(0)
  })

  test('buildToolsGuidance returns member_bios prompt regardless of useRealNames', async () => {
    const guidance = await buildToolsGuidance(['member_bios'])
    expect(guidance).toContain('search_members')
    expect(guidance).toContain('get_member')
    expect(guidance).toContain('untrusted user-supplied text')
  })

  test('resource_search factory returns search_resources when activeConversationId is provided', async () => {
    const tools = await getTools(['resource_search'], { activeConversationId: '507f1f77bcf86cd799439012' })
    expect(tools.map((t) => t.name)).toEqual(['search_resources'])
  })

  test('resource_search factory returns empty array without activeConversationId in context', async () => {
    const tools = await getTools(['resource_search'], {})
    expect(tools).toHaveLength(0)
  })

  test('buildToolsGuidance lists uploaded resource titles so the model can judge relevance', async () => {
    const user = await createUser('Guidance Tester')
    const topic = await createPublicTopic()
    const conversation = await createConversation(
      {
        name: 'Guidance Test Conversation',
        resources: [
          {
            source: 'speaker',
            category: 'required',
            title: 'The public domain: Enclosing the commons of the mind',
            authors: ['James Boyle'],
            year: '2008'
          }
        ]
      },
      user,
      topic
    )

    const guidance = await buildToolsGuidance(['resource_search'], {
      activeConversationId: conversation._id.toString()
    })
    expect(guidance).toContain('search_resources')
    expect(guidance).toContain('The public domain: Enclosing the commons of the mind')
    expect(guidance).toContain('James Boyle, 2008')
  })

  test('buildToolsGuidance includes a topic hint from description, falling back to summary', async () => {
    const user = await createUser('Topic Hint Tester')
    const topic = await createPublicTopic()
    const conversation = await createConversation(
      {
        name: 'Topic Hint Conversation',
        resources: [
          {
            source: 'speaker',
            category: 'required',
            title: 'Resource With Description',
            description: 'A short organizer-authored blurb about this reading.'
          },
          {
            source: 'speaker',
            category: 'required',
            title: 'Resource With Only Summary',
            summary: '**Main Thesis**\n- AI-generated summary content goes here.'
          }
        ]
      },
      user,
      topic
    )

    const guidance = await buildToolsGuidance(['resource_search'], {
      activeConversationId: conversation._id.toString()
    })
    expect(guidance).toContain('A short organizer-authored blurb about this reading.')
    expect(guidance).toContain('AI-generated summary content goes here.')
  })

  test('buildToolsGuidance omits the resource_search section when the conversation has no resources', async () => {
    const user = await createUser('No Resources Tester')
    const topic = await createPublicTopic()
    const conversation = await createConversation({ name: 'No Resources Conversation' }, user, topic)

    const guidance = await buildToolsGuidance(['resource_search'], {
      activeConversationId: conversation._id.toString()
    })
    expect(guidance).toBe('')
  })

  test('buildToolsGuidance omits the resource_search section without activeConversationId in context', async () => {
    const guidance = await buildToolsGuidance(['resource_search'])
    expect(guidance).toBe('')
  })
})
