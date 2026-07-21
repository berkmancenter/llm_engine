import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import ConversationCost from '../../../src/models/conversationCost.model.js'

setupIntTest()

function minimalAggregate() {
  return {
    estimatedCostUSD: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    llmCallCount: 0,
    models: [],
    agents: [],
    hasUnpricedCalls: false
  }
}

describe('ConversationCost model', () => {
  it('defaults status to pending and topicIsPrivate to false when not set', async () => {
    const doc = await ConversationCost.create({
      conversationId: new mongoose.Types.ObjectId(),
      liveEvent: minimalAggregate(),
      postEvent: minimalAggregate()
    })

    expect(doc.status).toBe('pending')
    expect(doc.topicIsPrivate).toBe(false)
  })

  it('persists an explicit complete status and topicIsPrivate flag', async () => {
    const doc = await ConversationCost.create({
      conversationId: new mongoose.Types.ObjectId(),
      liveEvent: minimalAggregate(),
      postEvent: minimalAggregate(),
      status: 'complete',
      topicIsPrivate: true
    })

    const found = await ConversationCost.findById(doc._id)
    expect(found!.status).toBe('complete')
    expect(found!.topicIsPrivate).toBe(true)
  })
})
