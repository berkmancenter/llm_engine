import { extractToolCallTraceFromAgentResult } from '../../../src/agents/helpers/llmChain.js'

describe('extractToolCallTraceFromAgentResult', () => {
  test('returns invoked false and empty calls when there are no tool_calls', () => {
    const agentResult = {
      messages: [{ _getType: () => 'human' }, { _getType: () => 'ai', tool_calls: [] }]
    }
    expect(extractToolCallTraceFromAgentResult(agentResult)).toEqual({ invoked: false, calls: [] })
  })

  test('collects tool_calls from every AIMessage in order', () => {
    const agentResult = {
      messages: [
        { _getType: () => 'human' },
        {
          _getType: () => 'ai',
          tool_calls: [{ name: 'web_search', args: { query: 'first' } }]
        },
        {
          _getType: () => 'ai',
          tool_calls: [
            { name: 'web_search', args: { query: 'second' } },
            { name: 'other_tool', args: { x: 1 } }
          ]
        }
      ]
    }
    const trace = extractToolCallTraceFromAgentResult(agentResult)
    expect(trace.invoked).toBe(true)
    expect(trace.calls).toEqual([
      { name: 'web_search', args: { query: 'first' } },
      { name: 'web_search', args: { query: 'second' } },
      { name: 'other_tool', args: { x: 1 } }
    ])
  })

  test('skips tool call entries without a name', () => {
    const agentResult = {
      messages: [
        {
          _getType: () => 'ai',
          tool_calls: [{ name: 'web_search', args: {} }, { args: { only: 'args' } }, { name: '', args: {} }]
        }
      ]
    }
    const trace = extractToolCallTraceFromAgentResult(agentResult)
    expect(trace.calls).toEqual([{ name: 'web_search', args: {} }])
  })
})
