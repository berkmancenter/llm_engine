import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { ConversationCost } from '../../../src/models/index.js'
import conversationCostService from '../../../src/services/conversationCost.service.js'

setupIntTest()

function makeAggregate(overrides = {}) {
  return {
    estimatedCostUSD: 1.2,
    totalPromptTokens: 1500,
    totalCompletionTokens: 300,
    llmCallCount: 2,
    models: [{ model: 'claude-sonnet', llmCalls: 2, promptTokens: 1500, completionTokens: 300, estimatedCostUSD: 1.2 }],
    agents: [{ agentType: 'vibesAnalyst', llmCalls: 2, estimatedCostUSD: 1.2 }],
    ...overrides
  }
}

const phases = {
  liveEvent: makeAggregate({
    estimatedCostUSD: 0.1,
    agents: [{ agentType: 'eventAssistant', llmCalls: 1, estimatedCostUSD: 0.1 }]
  }),
  postEvent: makeAggregate()
}

describe('conversationCost service', () => {
  it('persists liveEvent and postEvent separately, refreshed on re-stop rather than duplicated', async () => {
    const conversation = { _id: new mongoose.Types.ObjectId(), name: 'The Future of Work' }

    await conversationCostService.persistCost(conversation, phases)
    await conversationCostService.persistCost(conversation, {
      ...phases,
      postEvent: makeAggregate({ estimatedCostUSD: 2.0 })
    })

    const docs = await ConversationCost.find({ conversationId: conversation._id })
    expect(docs).toHaveLength(1)
    expect(docs[0].name).toBe('The Future of Work')
    expect(docs[0].source).toBe('langsmith')
    expect(docs[0].liveEvent.estimatedCostUSD).toBe(0.1)
    expect(docs[0].liveEvent.agents[0].agentType).toBe('eventAssistant')
    expect(docs[0].postEvent.estimatedCostUSD).toBe(2.0)
    expect(docs[0].postEvent.models[0].model).toBe('claude-sonnet')
    expect(docs[0].capturedAt).toBeInstanceOf(Date)
  })
})
