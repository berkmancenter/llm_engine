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
    models: [
      { model: 'claude-sonnet', llmCalls: 2, promptTokens: 1500, completionTokens: 300, estimatedCostUSD: 1.2, priced: true }
    ],
    agents: [{ agentType: 'vibesAnalyst', llmCalls: 2, estimatedCostUSD: 1.2 }],
    hasUnpricedCalls: false,
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
  describe('createPending', () => {
    it('creates a zeroed, pending record immediately, tagged with topicIsPrivate', async () => {
      const conversation = { _id: new mongoose.Types.ObjectId(), name: 'The Future of Work' }

      await conversationCostService.createPending(conversation, { topicIsPrivate: false })

      const doc = await ConversationCost.findOne({ conversationId: conversation._id })
      expect(doc!.status).toBe('pending')
      expect(doc!.topicIsPrivate).toBe(false)
      expect(doc!.name).toBe('The Future of Work')
      expect(doc!.liveEvent.llmCallCount).toBe(0)
      expect(doc!.postEvent.llmCallCount).toBe(0)
    })

    it('does not clobber an existing record if one is already there', async () => {
      const conversation = { _id: new mongoose.Types.ObjectId(), name: 'The Future of Work' }
      await conversationCostService.persistCost(conversation, phases, { topicIsPrivate: false })

      await conversationCostService.createPending(conversation, { topicIsPrivate: false })

      const doc = await ConversationCost.findOne({ conversationId: conversation._id })
      expect(doc!.status).toBe('complete')
      expect(doc!.liveEvent.estimatedCostUSD).toBe(0.1)
    })
  })

  describe('persistCost', () => {
    it('persists liveEvent and postEvent separately, refreshed on re-stop rather than duplicated', async () => {
      const conversation = { _id: new mongoose.Types.ObjectId(), name: 'The Future of Work' }

      await conversationCostService.persistCost(conversation, phases, { topicIsPrivate: false })
      await conversationCostService.persistCost(
        conversation,
        { ...phases, postEvent: makeAggregate({ estimatedCostUSD: 2.0 }) },
        { topicIsPrivate: false }
      )

      const docs = await ConversationCost.find({ conversationId: conversation._id })
      expect(docs).toHaveLength(1)
      expect(docs[0].name).toBe('The Future of Work')
      expect(docs[0].source).toBe('langsmith')
      expect(docs[0].status).toBe('complete')
      expect(docs[0].liveEvent.estimatedCostUSD).toBe(0.1)
      expect(docs[0].liveEvent.agents[0].agentType).toBe('eventAssistant')
      expect(docs[0].postEvent.estimatedCostUSD).toBe(2.0)
      expect(docs[0].postEvent.models[0].model).toBe('claude-sonnet')
      expect(docs[0].capturedAt).toBeInstanceOf(Date)
    })

    it('persists the unpriced-call flag on both the model row and the phase aggregate', async () => {
      const conversation = { _id: new mongoose.Types.ObjectId(), name: 'Self-hosted event' }
      const unpricedPhases = {
        liveEvent: makeAggregate({
          models: [
            { model: 'llama3-local', llmCalls: 1, promptTokens: 200, completionTokens: 40, estimatedCostUSD: 0, priced: false }
          ],
          hasUnpricedCalls: true
        }),
        postEvent: makeAggregate()
      }

      await conversationCostService.persistCost(conversation, unpricedPhases, { topicIsPrivate: false })

      const doc = await ConversationCost.findOne({ conversationId: conversation._id })
      expect(doc!.liveEvent.hasUnpricedCalls).toBe(true)
      expect(doc!.liveEvent.models[0].priced).toBe(false)
      expect(doc!.postEvent.hasUnpricedCalls).toBe(false)
    })

    it('marks the record complete and private when persisting a private event', async () => {
      const conversation = { _id: new mongoose.Types.ObjectId(), name: 'Private session' }

      await conversationCostService.persistCost(conversation, phases, { topicIsPrivate: true })

      const doc = await ConversationCost.findOne({ conversationId: conversation._id })
      expect(doc!.status).toBe('complete')
      expect(doc!.topicIsPrivate).toBe(true)
    })
  })
})
