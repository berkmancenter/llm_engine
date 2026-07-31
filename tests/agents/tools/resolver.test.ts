import type { StructuredToolInterface } from '@langchain/core/tools'
import { resolveTools } from '../../../src/agents/tools/resolver.js'
import { registerTool } from '../../../src/agents/tools/registry.js'
import type { ConversationGoal } from '../../../src/types/index.types.js'

function makeGoal(overrides: Partial<ConversationGoal> = {}): ConversationGoal {
  return {
    id: 'test_goal',
    label: 'Test Goal',
    description: 'A goal for resolver tests.',
    channel: 'groupChat',
    triggers: { conditions: [], minConfidence: 60 },
    guardrails: [],
    outputContract: { format: 'text' },
    examples: ['example'],
    ...overrides
  }
}

describe('resolveTools', () => {
  test('returns no tools when nothing is configured', () => {
    const result = resolveTools({})
    expect(result.tools).toEqual([])
    expect(result.toolNames).toEqual([])
    expect(result.promptGuidance).toBe('')
  })

  test('merges default, configured, goal-derived, and extra tool names, deduped', () => {
    const goal = makeGoal({ tools: [{ name: 'web_search' }] })
    const result = resolveTools({
      defaultTools: ['web_search'],
      configuredTools: ['search_semantic_scholar'],
      goals: [goal],
      extraTools: ['search_semantic_scholar']
    })
    expect(result.toolNames.sort()).toEqual(['search_semantic_scholar', 'web_search'])
    expect(result.tools.map((t) => t.name).sort()).toEqual(['search_semantic_scholar', 'web_search'])
  })

  test('unknown tool names are dropped, matching getTools behavior', () => {
    const result = resolveTools({ configuredTools: ['not_a_real_tool'] })
    expect(result.toolNames).toEqual(['not_a_real_tool'])
    expect(result.tools).toEqual([])
  })

  test('applies a goal tool config override to a config-aware factory', () => {
    const goal = makeGoal({ tools: [{ name: 'web_search', config: { maxResults: 3 } }] })
    const result = resolveTools({ goals: [goal] })
    const webSearch = result.tools.find((t) => t.name === 'web_search') as unknown as {
      schema: { parse: (v: unknown) => { maxResults: number } }
    }
    expect(webSearch.schema.parse({ query: 'x' }).maxResults).toBe(3)
  })

  test('first goal to reference a tool wins on conflicting config', () => {
    const goalA = makeGoal({ id: 'goal_a', tools: [{ name: 'web_search', config: { maxResults: 2 } }] })
    const goalB = makeGoal({ id: 'goal_b', tools: [{ name: 'web_search', config: { maxResults: 9 } }] })
    const result = resolveTools({ goals: [goalA, goalB] })
    const webSearch = result.tools.find((t) => t.name === 'web_search') as unknown as {
      schema: { parse: (v: unknown) => { maxResults: number } }
    }
    expect(webSearch.schema.parse({ query: 'x' }).maxResults).toBe(2)
  })

  test('promptGuidance includes a tool\'s registered static guidance', () => {
    const goal = makeGoal({ tools: [{ name: 'web_search' }] })
    const result = resolveTools({ goals: [goal] })
    expect(result.promptGuidance).toMatch(/search first when not certain/i)
  })

  test('promptGuidance appends a goal\'s usageNotes after the tool\'s static guidance', () => {
    const goal = makeGoal({ tools: [{ name: 'web_search', usageNotes: 'Prefer academic sources for this goal.' }] })
    const result = resolveTools({ goals: [goal] })
    expect(result.promptGuidance).toMatch(/search first when not certain/i)
    expect(result.promptGuidance).toContain('Prefer academic sources for this goal.')
    expect(result.promptGuidance.indexOf('search first')).toBeLessThan(
      result.promptGuidance.indexOf('Prefer academic sources for this goal.')
    )
  })

  test('promptGuidance concatenates usageNotes from multiple goals referencing the same tool', () => {
    const goalA = makeGoal({ id: 'goal_a', tools: [{ name: 'web_search', usageNotes: 'Note from goal A.' }] })
    const goalB = makeGoal({ id: 'goal_b', tools: [{ name: 'web_search', usageNotes: 'Note from goal B.' }] })
    const result = resolveTools({ goals: [goalA, goalB] })
    expect(result.promptGuidance).toContain('Note from goal A.')
    expect(result.promptGuidance).toContain('Note from goal B.')
  })

  test('promptGuidance omits a tool with no registered guidance and no usageNotes', () => {
    registerTool('resolver_test_no_guidance_tool', () => ({ name: 'resolver_test_no_guidance_tool' } as unknown as StructuredToolInterface))
    const goal = makeGoal({ tools: [{ name: 'resolver_test_no_guidance_tool' }] })
    const result = resolveTools({ goals: [goal] })
    expect(result.promptGuidance).toBe('')
  })

  test('passes toolContext through to factories alongside the derived toolConfig', () => {
    let received: Record<string, unknown> | null = null
    registerTool('resolver_test_context_tool', (ctx) => {
      received = ctx ?? null
      return { name: 'resolver_test_context_tool' } as unknown as StructuredToolInterface
    })
    const goal = makeGoal({ tools: [{ name: 'resolver_test_context_tool', config: { foo: 'bar' } }] })
    resolveTools({ goals: [goal], toolContext: { activeConversationId: 'abc123' } })
    expect(received).toEqual({
      activeConversationId: 'abc123',
      toolConfig: { resolver_test_context_tool: { foo: 'bar' } }
    })
  })
})
