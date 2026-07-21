import mongoose from 'mongoose'
import { Conversation, Agent } from '../../../src/models/index.js'
import { publicTopic, conversationAgentsEnabled } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture.js'
import handlers from '../../../src/jobs/handlers/conversationCost.js'
import conversationCostTrackingService from '../../../src/services/conversationCostTracking.service.js'
import setupIntTest from '../../utils/setupIntTest.js'

setupIntTest()

describe('conversationCost handler', () => {
  let conversation

  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])
    conversation = new Conversation({ ...conversationAgentsEnabled, active: true })
    await conversation.save()
    jest.restoreAllMocks()
  })

  const makeJob = (overrides: Record<string, unknown> = {}) => ({
    attrs: {
      data: {
        conversationId: conversation._id.toString(),
        topicIsPrivate: false,
        ...overrides
      }
    }
  })

  test('does not throw when the conversation is not found', async () => {
    const fakeId = new mongoose.Types.ObjectId()
    await expect(handlers.conversationCost(makeJob({ conversationId: fakeId.toString() }))).resolves.not.toThrow()
  })

  test('tracks cost directly when no active Number Cruncher agent exists', async () => {
    const trackSpy = jest.spyOn(conversationCostTrackingService, 'trackConversationCost').mockResolvedValue(null)

    await handlers.conversationCost(makeJob())

    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ _id: conversation._id }),
      { topicIsPrivate: false }
    )
  })

  test('steps aside when an active Number Cruncher agent exists, to avoid a duplicate settle-poll', async () => {
    const ncConversation = new Conversation({
      ...conversationAgentsEnabled,
      _id: new mongoose.Types.ObjectId(),
      active: true
    })
    await ncConversation.save()
    const ncAgent = new Agent({ agentType: 'numberCruncher', conversation: ncConversation._id, active: true })
    await ncAgent.save()
    const trackSpy = jest.spyOn(conversationCostTrackingService, 'trackConversationCost').mockResolvedValue(null)

    await handlers.conversationCost(makeJob())

    expect(trackSpy).not.toHaveBeenCalled()
  })

  test('does not throw when trackConversationCost fails', async () => {
    jest.spyOn(conversationCostTrackingService, 'trackConversationCost').mockRejectedValue(new Error('langsmith down'))

    await expect(handlers.conversationCost(makeJob())).resolves.not.toThrow()
  })
})
