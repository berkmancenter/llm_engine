import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchConversationCost = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchWithSettle = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIsConfigured = jest.fn<(...args: any[]) => boolean>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreatePending = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPersistCost = jest.fn<(...args: any[]) => Promise<any>>()

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

const ZERO_AGGREGATE = {
  estimatedCostUSD: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  llmCallCount: 0,
  models: [],
  agents: [],
  hasUnpricedCalls: false
}
const ZERO_PHASES = { liveEvent: ZERO_AGGREGATE, postEvent: ZERO_AGGREGATE }

jest.unstable_mockModule('../src/agents/numberCruncher/conversationCost.js', () => ({
  fetchConversationCost: mockFetchConversationCost,
  fetchConversationCostWithSettle: mockFetchWithSettle,
  combineCostAggregates: stubCombine,
  isLangsmithCostTrackingConfigured: mockIsConfigured
}))
jest.unstable_mockModule('../src/services/conversationCost.service.js', () => ({
  default: { createPending: mockCreatePending, persistCost: mockPersistCost },
  ZERO_PHASES
}))

const { trackConversationCost } = await import('../../../src/services/conversationCostTracking.service.js')

function makeAggregate(overrides = {}) {
  return {
    estimatedCostUSD: 1.0,
    totalPromptTokens: 1000,
    totalCompletionTokens: 200,
    llmCallCount: 2,
    models: [{ model: 'claude-sonnet', llmCalls: 2, promptTokens: 1000, completionTokens: 200, estimatedCostUSD: 1.0, priced: true }],
    agents: [{ agentType: 'eventAssistant', llmCalls: 2, estimatedCostUSD: 1.0 }],
    hasUnpricedCalls: false,
    ...overrides
  }
}

const phases = {
  liveEvent: makeAggregate(),
  postEvent: makeAggregate({ estimatedCostUSD: 0.47 })
}

const conversation = { _id: 'c1', name: 'The Future of Work' }

describe('trackConversationCost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsConfigured.mockReturnValue(true)
    mockFetchConversationCost.mockResolvedValue(phases)
    mockFetchWithSettle.mockResolvedValue(phases)
    mockCreatePending.mockResolvedValue({})
    mockPersistCost.mockResolvedValue({})
  })

  it('skips entirely when LangSmith tracing is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)

    const result = await trackConversationCost(conversation, { topicIsPrivate: false })

    expect(result).toBeNull()
    expect(mockFetchConversationCost).not.toHaveBeenCalled()
    expect(mockCreatePending).not.toHaveBeenCalled()
    expect(mockFetchWithSettle).not.toHaveBeenCalled()
  })

  it('creates a pending record with the real preliminary numbers, before settling', async () => {
    await trackConversationCost(conversation, { topicIsPrivate: false })

    expect(mockCreatePending).toHaveBeenCalledWith(conversation, phases, { topicIsPrivate: false })
    const pendingOrder = mockCreatePending.mock.invocationCallOrder[0]
    const settleOrder = mockFetchWithSettle.mock.invocationCallOrder[0]
    expect(pendingOrder).toBeLessThan(settleOrder)
  })

  it('falls back to zeroed phases for the pending record when no preliminary data is available yet', async () => {
    mockFetchConversationCost.mockResolvedValue(null)

    await trackConversationCost(conversation, { topicIsPrivate: false })

    expect(mockCreatePending).toHaveBeenCalledWith(conversation, ZERO_PHASES, { topicIsPrivate: false })
  })

  it('persists the settled phases as complete and returns the combined total', async () => {
    const result = await trackConversationCost(conversation, { topicIsPrivate: true })

    expect(mockPersistCost).toHaveBeenCalledWith(conversation, phases, { topicIsPrivate: true })
    expect(result?.total.estimatedCostUSD).toBeCloseTo(1.47)
    expect(result?.phases).toBe(phases)
  })

  it('finalizes with zero cost and returns null when nothing settles', async () => {
    mockFetchWithSettle.mockResolvedValue(null)

    const result = await trackConversationCost(conversation, { topicIsPrivate: false })

    expect(result).toBeNull()
    expect(mockPersistCost).toHaveBeenCalledWith(conversation, ZERO_PHASES, { topicIsPrivate: false })
  })

  it('does not throw when createPending fails, and still runs the settle-poll', async () => {
    mockCreatePending.mockRejectedValue(new Error('db down'))

    const result = await trackConversationCost(conversation, { topicIsPrivate: false })

    expect(mockFetchWithSettle).toHaveBeenCalled()
    expect(result?.total.estimatedCostUSD).toBeCloseTo(1.47)
  })

  it('does not throw when persistCost fails, and still returns the settled result', async () => {
    mockPersistCost.mockRejectedValue(new Error('db down'))

    const result = await trackConversationCost(conversation, { topicIsPrivate: false })

    expect(result?.total.estimatedCostUSD).toBeCloseTo(1.47)
  })
})
