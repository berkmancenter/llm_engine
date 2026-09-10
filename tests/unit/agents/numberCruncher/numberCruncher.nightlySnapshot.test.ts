import { jest } from '@jest/globals'
import path from 'path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIsConfigured = jest.fn<(...args: any[]) => boolean>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchConversationCost = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCombineCostAggregates = jest.fn<(...args: any[]) => any>()

// An absolute path sidesteps any ambiguity in how unstable_mockModule resolves a
// relative specifier — it must match agent.ts's own resolved import exactly.
const conversationCostModulePath = path.resolve(process.cwd(), 'src/agents/numberCruncher/conversationCost.ts')

jest.unstable_mockModule(conversationCostModulePath, () => ({
  isLangsmithCostTrackingConfigured: mockIsConfigured,
  fetchConversationCost: mockFetchConversationCost,
  combineCostAggregates: mockCombineCostAggregates,
  fetchConversationCostWithSettle: jest.fn()
}))

/* Every one of these — including setupIntTest, which statically pulls in the agenda/jobs
   module and, through it, the whole agent-type registry (numberCruncher/agent.ts and its
   conversationCost.ts import) — must be imported dynamically, after the mock above. A
   static import here would hoist ahead of jest.unstable_mockModule (ESM import hoisting),
   loading the real conversationCost.ts before the mock ever gets a chance to intercept it. */
const mongoose = (await import('mongoose')).default
const { default: setupIntTest } = await import('../../../utils/setupIntTest.js')
const { newPublicTopic, newPrivateTopic, insertTopics } = await import('../../../fixtures/topic.fixture.js')
const { default: numberCruncher } = await import('../../../../src/agents/numberCruncher/agent.js')
const { default: Conversation } = await import('../../../../src/models/conversation.model.js')
const { default: ConversationCost } = await import('../../../../src/models/conversationCost.model.js')

setupIntTest()

const adminChannel = { name: 'number-cruncher-admin' }

function buildContext() {
  return { agentConfig: {}, conversation: { channels: [adminChannel] } }
}

function makeAggregate(overrides = {}) {
  return {
    estimatedCostUSD: 0.5,
    totalPromptTokens: 500,
    totalCompletionTokens: 100,
    llmCallCount: 1,
    models: [
      { model: 'claude-sonnet', llmCalls: 1, promptTokens: 500, completionTokens: 100, estimatedCostUSD: 0.5, priced: true }
    ],
    agents: [{ agentType: 'eventAssistant', llmCalls: 1, estimatedCostUSD: 0.5 }],
    hasUnpricedCalls: false,
    ...overrides
  }
}

const phases = { liveEvent: makeAggregate(), postEvent: makeAggregate({ estimatedCostUSD: 0, llmCallCount: 0 }) }
const total = makeAggregate()

async function insertConversation(overrides: Record<string, unknown> = {}) {
  const { private: isPrivateTopic, ...conversationOverrides } = overrides
  const topic = isPrivateTopic ? newPrivateTopic() : newPublicTopic()
  await insertTopics([topic])
  const conversation = await Conversation.create({
    _id: new mongoose.Types.ObjectId(),
    name: 'The Future of Work',
    owner: new mongoose.Types.ObjectId(),
    topic: topic._id,
    active: true,
    draft: false,
    messages: [],
    transcript: { status: 'active' },
    ...conversationOverrides
  })
  return conversation
}

describe('numberCruncher respond() nightly cost snapshot', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsConfigured.mockReturnValue(true)
    mockFetchConversationCost.mockResolvedValue(phases)
    mockCombineCostAggregates.mockReturnValue(total)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('does nothing when LangSmith cost tracking is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)
    await insertConversation()

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toEqual([])
    expect(mockFetchConversationCost).not.toHaveBeenCalled()
  })

  it('posts a snapshot for an active conversation and persists it as pending', async () => {
    const conversation = await insertConversation()

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toHaveLength(1)
    expect(responses[0].responseKind).toBe('conversationCostSummary')
    expect(responses[0].channels).toEqual([adminChannel])
    expect(responses[0].message).toContain('The Future of Work')

    const doc = await ConversationCost.findOne({ conversationId: conversation._id })
    expect(doc!.status).toBe('pending')
    expect(doc!.liveEvent.estimatedCostUSD).toBe(0.5)
  })

  it('ignores conversations that are not active', async () => {
    await insertConversation({ active: false })

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toEqual([])
    expect(mockFetchConversationCost).not.toHaveBeenCalled()
  })

  it('ignores draft conversations', async () => {
    await insertConversation({ draft: true })

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toEqual([])
    expect(mockFetchConversationCost).not.toHaveBeenCalled()
  })

  it('skips a conversation with no LLM calls yet', async () => {
    mockCombineCostAggregates.mockReturnValue({ ...total, llmCallCount: 0 })
    await insertConversation()

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toEqual([])
  })

  it('skips a conversation already snapshotted recently (debounce against a retried job)', async () => {
    const conversation = await insertConversation()
    await ConversationCost.create({
      conversationId: conversation._id,
      name: conversation.name,
      liveEvent: total,
      postEvent: phases.postEvent,
      status: 'pending',
      capturedAt: new Date(),
      topicIsPrivate: false
    })

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toEqual([])
    expect(mockFetchConversationCost).not.toHaveBeenCalled()
  })

  it('does not debounce against a stale completed record from a prior stop (conversation restarted)', async () => {
    // A conversation can restart after stopping (startConversation has no guard against
    // that). Its ConversationCost record from that earlier stop is 'complete' and may still
    // be recent — the debounce must not treat that as "already snapshotted tonight" and
    // skip a conversation that is genuinely active again.
    const conversation = await insertConversation()
    await ConversationCost.create({
      conversationId: conversation._id,
      name: conversation.name,
      liveEvent: total,
      postEvent: phases.postEvent,
      status: 'complete',
      capturedAt: new Date(),
      topicIsPrivate: false
    })

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toHaveLength(1)
    expect(mockFetchConversationCost).toHaveBeenCalledWith(String(conversation._id))
    const doc = await ConversationCost.findOne({ conversationId: conversation._id })
    expect(doc!.status).toBe('pending')
  })

  it('redacts the conversation name for a private-topic conversation', async () => {
    await insertConversation({ private: true })

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toHaveLength(1)
    expect(responses[0].message).not.toContain('The Future of Work')
    const renderData = responses[0].renderData as { topicIsPrivate: boolean }
    expect(renderData.topicIsPrivate).toBe(true)
  })

  it('posts one snapshot per active conversation', async () => {
    await insertConversation({ _id: new mongoose.Types.ObjectId(), name: 'Event A' })
    await insertConversation({ _id: new mongoose.Types.ObjectId(), name: 'Event B' })

    const responses = await numberCruncher.respond.call(buildContext())

    expect(responses).toHaveLength(2)
  })

  it('produces both a budget alert and a cost snapshot in the same tick, since they now share one cron', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ quota: { limit: '250.0', limit_unit: 'USD' }, remaining_limit: '30.0' })
    } as Response)
    await insertConversation()

    const responses = await numberCruncher.respond.call({
      agentConfig: {
        budgets: [{ label: 'AWS Bedrock', endpoint: 'https://api.example.com/budget', apiKey: 'key', thresholdPercent: 15 }]
      },
      conversation: { channels: [adminChannel] }
    })

    expect(responses).toHaveLength(2)
    const kinds = responses.map((r) => r.responseKind).sort()
    expect(kinds).toEqual(['budgetAlert', 'conversationCostSummary'])
    fetchSpy.mockRestore()
  })
})
