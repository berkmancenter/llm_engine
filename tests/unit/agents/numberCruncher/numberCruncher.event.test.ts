import { jest } from '@jest/globals'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTrackConversationCost = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/services/conversationCostTracking.service.js', () => ({
  default: { trackConversationCost: mockTrackConversationCost },
  trackConversationCost: mockTrackConversationCost
}))

const { default: numberCruncher } = await import('../../../../src/agents/numberCruncher/agent.js')
const { default: Conversation } = await import('../../../../src/models/conversation.model.js')

const adminChannel = { name: 'number-cruncher-admin' }

// A fake agent context: __t marks it as an Agent for the access check, and the
// allTopics read grant matches every conversationStopped event, public or private.
function buildContext() {
  return {
    __t: 'Agent',
    capabilities: { read: [{ type: 'allTopics' }], write: [{ type: 'ownConversation' }] },
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

const total = {
  estimatedCostUSD: 1.47,
  totalPromptTokens: 2000,
  totalCompletionTokens: 400,
  llmCallCount: 4,
  models: phases.liveEvent.models,
  agents: [...phases.liveEvent.agents, ...phases.postEvent.agents],
  hasUnpricedCalls: false
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
    mockTrackConversationCost.mockResolvedValue({ phases, total })
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

    expect(mockTrackConversationCost).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'The Future of Work' }),
      { topicIsPrivate: false }
    )
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
      topicIsPrivate: boolean
    }
    expect(renderData.conversationName).toBe('The Future of Work')
    expect(renderData.total.estimatedCostUSD).toBeCloseTo(1.47)
    expect(renderData.liveEvent.estimatedCostUSD).toBeCloseTo(1.0)
    expect(renderData.postEvent.estimatedCostUSD).toBeCloseTo(0.47)
    expect(renderData.checkedAt).toBeTruthy()
    expect(renderData.topicIsPrivate).toBe(false)
  })

  it('mentions unpriced calls in the fallback message when the total has any', async () => {
    mockStoppedConversation(false)
    mockTrackConversationCost.mockResolvedValue({ phases, total: { ...total, hasUnpricedCalls: true } })

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(responses[0].message).toContain('could not be priced')
    const renderData = responses[0].renderData as { total: { hasUnpricedCalls: boolean } }
    expect(renderData.total.hasUnpricedCalls).toBe(true)
  })

  it('records liveEvent cost for a private-topic event with a redacted name, and marks it private', async () => {
    mockStoppedConversation(true)

    const responses = await numberCruncher.onConversationEvent.call(buildContext(), {
      type: 'conversationStopped',
      conversationId: 'c1'
    })

    expect(mockTrackConversationCost).toHaveBeenCalledWith(expect.anything(), { topicIsPrivate: true })
    expect(responses).toHaveLength(1)
    expect(responses[0].message).not.toContain('The Future of Work')
    const renderData = responses[0].renderData as { topicIsPrivate: boolean; conversationName: string }
    expect(renderData.topicIsPrivate).toBe(true)
    // The real name is still carried in renderData for internal consumers — only the
    // Slack card (Task 7) and the fallback message text redact it for display.
    expect(renderData.conversationName).toBe('The Future of Work')
  })

  it('posts nothing when cost tracking finds nothing to report', async () => {
    mockStoppedConversation(false)
    mockTrackConversationCost.mockResolvedValue(null)

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
    expect(mockTrackConversationCost).not.toHaveBeenCalled()
  })
})
