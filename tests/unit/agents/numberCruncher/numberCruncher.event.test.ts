import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchWithSettle = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPersistCost = jest.fn<(...args: any[]) => Promise<any>>()

// A self-contained stand-in for combineCostAggregates (no cross-model/agent dedup —
// the fixtures below don't overlap) rather than importing the real one: importing
// the real module before this mock registers would risk defeating the mock (see
// tests/CLAUDE.md). combineCostAggregates' own merge logic is exercised by
// tests/unit/agents/numberCruncher/conversationCost.test.ts; this file only checks
// that numberCruncher wires fetch -> combine -> persist -> render correctly.
function stubCombine(a: Record<string, unknown>, b: Record<string, unknown>) {
  return {
    estimatedCostUSD: (a.estimatedCostUSD as number) + (b.estimatedCostUSD as number),
    totalPromptTokens: (a.totalPromptTokens as number) + (b.totalPromptTokens as number),
    totalCompletionTokens: (a.totalCompletionTokens as number) + (b.totalCompletionTokens as number),
    llmCallCount: (a.llmCallCount as number) + (b.llmCallCount as number),
    models: [...(a.models as unknown[]), ...(b.models as unknown[])],
    agents: [...(a.agents as unknown[]), ...(b.agents as unknown[])],
    hasUnpricedCalls: Boolean(a.hasUnpricedCalls) || Boolean(b.hasUnpricedCalls)
  }
}

jest.unstable_mockModule('../src/agents/numberCruncher/conversationCost.js', () => ({
  fetchConversationCost: jest.fn(),
  fetchConversationCostWithSettle: mockFetchWithSettle,
  combineCostAggregates: stubCombine
}))
jest.unstable_mockModule('../src/services/conversationCost.service.js', () => ({
  default: { persistCost: mockPersistCost }
}))

const { default: numberCruncher } = await import('../../../../src/agents/numberCruncher/agent.js')
const { default: Conversation } = await import('../../../../src/models/conversation.model.js')
const { AccessDeniedError } = await import('../../../../src/auth/access.js')

const adminChannel = { name: 'number-cruncher-admin' }

// A fake agent context: __t marks it as an Agent for the access check, and the
// allPublicTopics read grant matches any non-private event.
function buildContext() {
  return {
    __t: 'Agent',
    capabilities: { read: [{ type: 'allPublicTopics' }], write: [{ type: 'ownConversation' }] },
    conversation: { _id: 'nc-conv-id', channels: [adminChannel] }
  }
}

function makeAggregate(overrides = {}) {
  return {
    estimatedCostUSD: 1.0,
    totalPromptTokens: 1000,
    totalCompletionTokens: 200,
    llmCallCount: 2,
    models: [
      { model: 'claude-sonnet', llmCalls: 2, promptTokens: 1000, completionTokens: 200, estimatedCostUSD: 1.0, priced: true }
    ],
    agents: [{ agentType: 'eventAssistant', llmCalls: 2, estimatedCostUSD: 1.0 }],
    hasUnpricedCalls: false,
    ...overrides
  }
}

const phases = {
  liveEvent: makeAggregate(),
  postEvent: makeAggregate({
    estimatedCostUSD: 0.47,
    agents: [{ agentType: 'vibesAnalyst', llmCalls: 1, estimatedCostUSD: 0.47 }]
  })
}

function mockStoppedConversation(topicIsPrivate: boolean) {
  jest.spyOn(Conversation, 'findById').mockReturnValue({
    populate: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      _id: 'c1',
      name: 'The Future of Work',
      topic: { _id: 'topic-1', private: topicIsPrivate }
    })
  } as never)
}

describe('numberCruncher onConversationEvent', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetchWithSettle.mockResolvedValue(phases)
    mockPersistCost.mockResolvedValue({})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('posts a cost card with the combined total to its own admin channel', async () => {
    mockStoppedConversation(false)

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(mockFetchWithSettle).toHaveBeenCalledWith('c1')
    expect(responses).toHaveLength(1)
    expect(responses[0].responseKind).toBe('conversationCostSummary')
    expect(responses[0].visible).toBe(true)
    expect(responses[0].channels).toEqual([adminChannel])
    expect(responses[0].message).toContain('The Future of Work')
    expect(responses[0].message).toContain('$1.47')
    const renderData = responses[0].renderData as {
      conversationName: string
      total: { estimatedCostUSD: number }
      liveEvent: { estimatedCostUSD: number }
      postEvent: { estimatedCostUSD: number }
      checkedAt: string
    }
    expect(renderData.conversationName).toBe('The Future of Work')
    expect(renderData.total.estimatedCostUSD).toBeCloseTo(1.47)
    expect(renderData.liveEvent.estimatedCostUSD).toBeCloseTo(1.0)
    expect(renderData.postEvent.estimatedCostUSD).toBeCloseTo(0.47)
    expect(renderData.checkedAt).toBeTruthy()
  })

  it('mentions unpriced calls in the fallback message when the total has any', async () => {
    mockStoppedConversation(false)
    mockFetchWithSettle.mockResolvedValue({
      liveEvent: makeAggregate({ hasUnpricedCalls: true }),
      postEvent: makeAggregate({ estimatedCostUSD: 0.47, hasUnpricedCalls: false })
    })

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(responses[0].message).toContain('could not be priced')
    const renderData = responses[0].renderData as { total: { hasUnpricedCalls: boolean } }
    expect(renderData.total.hasUnpricedCalls).toBe(true)
  })

  it('persists both phases before posting', async () => {
    mockStoppedConversation(false)

    await numberCruncher.onConversationEvent.call(buildContext(), { type: 'conversationStopped', conversationId: 'c1' })

    expect(mockPersistCost).toHaveBeenCalledWith(expect.objectContaining({ name: 'The Future of Work' }), phases)
  })

  it('still posts the card when persistence fails', async () => {
    mockStoppedConversation(false)
    mockPersistCost.mockRejectedValue(new Error('db down'))

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(responses).toHaveLength(1)
  })

  it('refuses private-topic events (fail closed) without fetching costs', async () => {
    mockStoppedConversation(true)

    await expect(
      numberCruncher.onConversationEvent.call(buildContext(), { type: 'conversationStopped', conversationId: 'c1' })
    ).rejects.toThrow(AccessDeniedError)

    expect(mockFetchWithSettle).not.toHaveBeenCalled()
  })

  it('posts nothing when no cost data settles', async () => {
    mockStoppedConversation(false)
    mockFetchWithSettle.mockResolvedValue(null)

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(responses).toEqual([])
    expect(mockPersistCost).not.toHaveBeenCalled()
  })

  it('posts nothing when the conversation made no LLM calls in either phase', async () => {
    mockStoppedConversation(false)
    mockFetchWithSettle.mockResolvedValue({
      liveEvent: makeAggregate({ llmCallCount: 0, estimatedCostUSD: 0, models: [], agents: [] }),
      postEvent: makeAggregate({ llmCallCount: 0, estimatedCostUSD: 0, models: [], agents: [] })
    })

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(responses).toEqual([])
  })

  it('ignores other event types', async () => {
    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'somethingElse',
      conversationId: 'c1'
    })

    expect(responses).toEqual([])
    expect(mockFetchWithSettle).not.toHaveBeenCalled()
  })
})
