import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockListRuns = jest.fn<(...args: any[]) => unknown>()
const MockClient = jest.fn(() => ({ listRuns: mockListRuns }))

jest.unstable_mockModule('langsmith', () => ({ Client: MockClient }))
jest.unstable_mockModule('../src/config/config.js', () => ({
  default: { langsmith: { key: 'test-key', project: 'test-project' } }
}))
jest.unstable_mockModule('../src/config/logger.js', () => ({
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))

const { fetchConversationCost, fetchConversationCostWithSettle, combineCostAggregates } = await import(
  '../../../../src/agents/numberCruncher/conversationCost.js'
)

function asyncIterable(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item
  })()
}

// t1 = liveEvent (agentType eventAssistant), t2 = postEvent (agentType vibesAnalyst)
const rootRuns = [
  { id: 'r1', trace_id: 't1', name: 'eventAssistant', extra: { metadata: { costPhase: 'liveEvent' } } },
  { id: 'r2', trace_id: 't2', name: 'vibesAnalyst', extra: { metadata: { costPhase: 'postEvent' } } }
]

const llmRuns = [
  {
    id: 'l1',
    trace_id: 't1',
    name: 'ChatBedrock',
    prompt_tokens: 300,
    completion_tokens: 50,
    total_cost: 0.1,
    extra: { metadata: { ls_model_name: 'gpt-test' } }
  },
  {
    id: 'l2',
    trace_id: 't2',
    name: 'ChatBedrock',
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_cost: 0.5,
    extra: { metadata: { ls_model_name: 'claude-sonnet' } }
  },
  {
    id: 'l3',
    trace_id: 't2',
    name: 'ChatBedrock',
    prompt_tokens: 500,
    completion_tokens: 100,
    total_cost: 0.25,
    extra: { metadata: { ls_model_name: 'claude-sonnet' } }
  }
]

describe('fetchConversationCost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockListRuns.mockImplementation((params: { isRoot?: boolean }) =>
      params.isRoot ? asyncIterable(rootRuns) : asyncIterable(llmRuns)
    )
  })

  it("splits cost and tokens into liveEvent/postEvent by each run trace's costPhase", async () => {
    const result = await fetchConversationCost('conv-1')

    expect(result?.liveEvent).toEqual({
      estimatedCostUSD: 0.1,
      totalPromptTokens: 300,
      totalCompletionTokens: 50,
      llmCallCount: 1,
      models: [{ model: 'gpt-test', llmCalls: 1, promptTokens: 300, completionTokens: 50, estimatedCostUSD: 0.1 }],
      agents: [{ agentType: 'eventAssistant', llmCalls: 1, estimatedCostUSD: 0.1 }]
    })
    expect(result?.postEvent).toEqual({
      estimatedCostUSD: 0.75,
      totalPromptTokens: 1500,
      totalCompletionTokens: 300,
      llmCallCount: 2,
      models: [
        { model: 'claude-sonnet', llmCalls: 2, promptTokens: 1500, completionTokens: 300, estimatedCostUSD: 0.75 }
      ],
      agents: [{ agentType: 'vibesAnalyst', llmCalls: 2, estimatedCostUSD: 0.75 }]
    })
  })

  it('returns null (without querying llm runs) when no trace roots match', async () => {
    mockListRuns.mockImplementation(() => asyncIterable([]))

    const result = await fetchConversationCost('conv-none')

    expect(result).toBeNull()
    expect(mockListRuns).toHaveBeenCalledTimes(1)
  })

  it('returns zero aggregates for a phase whose root(s) made no llm calls', async () => {
    mockListRuns.mockImplementation((params: { isRoot?: boolean }) =>
      params.isRoot ? asyncIterable(rootRuns) : asyncIterable([])
    )

    const result = await fetchConversationCost('conv-quiet')

    expect(result?.liveEvent.llmCallCount).toBe(0)
    expect(result?.liveEvent.estimatedCostUSD).toBe(0)
    expect(result?.postEvent.llmCallCount).toBe(0)
  })

  it('defaults an llm run to liveEvent when its trace root is missing a costPhase', async () => {
    mockListRuns.mockImplementation((params: { isRoot?: boolean }) =>
      params.isRoot
        ? asyncIterable([{ id: 'r1', trace_id: 't1', name: 'someAgent', extra: { metadata: {} } }])
        : asyncIterable([
            {
              id: 'l1',
              trace_id: 't1',
              name: 'ChatBedrock',
              prompt_tokens: 10,
              completion_tokens: 5,
              total_cost: 0.01,
              extra: { metadata: { ls_model_name: 'gpt-test' } }
            }
          ])
    )

    const result = await fetchConversationCost('conv-untagged')

    expect(result?.liveEvent.llmCallCount).toBe(1)
    expect(result?.postEvent.llmCallCount).toBe(0)
  })

  it('returns null when the LangSmith query throws', async () => {
    mockListRuns.mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(fetchConversationCost('conv-err')).resolves.toBeNull()
  })
})

describe('combineCostAggregates', () => {
  it('merges two aggregates, summing shared models/agents and concatenating unique ones', () => {
    const a = {
      estimatedCostUSD: 0.1,
      totalPromptTokens: 300,
      totalCompletionTokens: 50,
      llmCallCount: 1,
      models: [{ model: 'gpt-test', llmCalls: 1, promptTokens: 300, completionTokens: 50, estimatedCostUSD: 0.1 }],
      agents: [{ agentType: 'eventAssistant', llmCalls: 1, estimatedCostUSD: 0.1 }]
    }
    const b = {
      estimatedCostUSD: 0.75,
      totalPromptTokens: 1500,
      totalCompletionTokens: 300,
      llmCallCount: 2,
      models: [
        { model: 'claude-sonnet', llmCalls: 2, promptTokens: 1500, completionTokens: 300, estimatedCostUSD: 0.75 }
      ],
      agents: [{ agentType: 'vibesAnalyst', llmCalls: 2, estimatedCostUSD: 0.75 }]
    }

    const combined = combineCostAggregates(a, b)

    expect(combined.estimatedCostUSD).toBeCloseTo(0.85)
    expect(combined.llmCallCount).toBe(3)
    expect(combined.totalPromptTokens).toBe(1800)
    expect(combined.models).toHaveLength(2)
    expect(combined.agents.map((x) => x.agentType).sort()).toEqual(['eventAssistant', 'vibesAnalyst'])
  })

  it('sums a model/agent that appears in both aggregates instead of duplicating it', () => {
    const a = {
      estimatedCostUSD: 0.1,
      totalPromptTokens: 100,
      totalCompletionTokens: 10,
      llmCallCount: 1,
      models: [{ model: 'claude-sonnet', llmCalls: 1, promptTokens: 100, completionTokens: 10, estimatedCostUSD: 0.1 }],
      agents: [{ agentType: 'eventAssistant', llmCalls: 1, estimatedCostUSD: 0.1 }]
    }
    const b = {
      estimatedCostUSD: 0.2,
      totalPromptTokens: 200,
      totalCompletionTokens: 20,
      llmCallCount: 1,
      models: [{ model: 'claude-sonnet', llmCalls: 1, promptTokens: 200, completionTokens: 20, estimatedCostUSD: 0.2 }],
      agents: [{ agentType: 'eventAssistant', llmCalls: 1, estimatedCostUSD: 0.2 }]
    }

    const combined = combineCostAggregates(a, b)

    // estimatedCostUSD compared separately with toBeCloseTo: 0.1 + 0.2 is not
    // exactly 0.3 in IEEE 754 floating point.
    expect(combined.models).toHaveLength(1)
    expect(combined.models[0]).toMatchObject({ model: 'claude-sonnet', llmCalls: 2, promptTokens: 300, completionTokens: 30 })
    expect(combined.models[0].estimatedCostUSD).toBeCloseTo(0.3)
    expect(combined.agents).toHaveLength(1)
    expect(combined.agents[0]).toMatchObject({ agentType: 'eventAssistant', llmCalls: 2 })
    expect(combined.agents[0].estimatedCostUSD).toBeCloseTo(0.3)
  })
})

describe('fetchConversationCostWithSettle', () => {
  it('polls until two consecutive reads see the same non-zero COMBINED call count', async () => {
    // Read 1 sees 2 llm runs total (recap still generating), reads 2 and 3 both see 3.
    let readIndex = -1
    mockListRuns.mockImplementation((params: { isRoot?: boolean }) => {
      if (params.isRoot) {
        readIndex += 1
        return asyncIterable(rootRuns)
      }
      return asyncIterable(readIndex === 0 ? llmRuns.slice(0, 2) : llmRuns)
    })

    const result = await fetchConversationCostWithSettle('conv-1', [0, 0, 0, 0])

    expect((result?.liveEvent.llmCallCount ?? 0) + (result?.postEvent.llmCallCount ?? 0)).toBe(3)
    // Settled on the third read (2 -> 3 -> 3); did not burn the remaining delays.
    expect(readIndex).toBe(2)
  })

  it('returns the last read when the delay budget runs out without settling', async () => {
    mockListRuns.mockImplementation(() => asyncIterable([]))

    const result = await fetchConversationCostWithSettle('conv-none', [0, 0])

    expect(result).toBeNull()
  })
})
