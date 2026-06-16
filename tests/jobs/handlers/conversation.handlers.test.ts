import { Conversation } from '../../../src/models/index.js'
import { publicTopic, conversationOne } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'
import JobHandlers from '../../../src/jobs/handlers/index.js'
import setupIntTest from '../../utils/setupIntTest.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'

setupIntTest()

describe('conversation handler tests', () => {
  let conversation

  beforeEach(async () => {
    await insertUsers([userOne])
    await insertTopics([publicTopic])

    conversation = new Conversation({ ...conversationOne, active: false })
    await conversation.save()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('autoStartConversation', () => {
    test('should start an inactive conversation', async () => {
      await JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.startTime).toBeDefined()
    })

    test('should skip if conversation is already active', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: true })

      await JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.startTime).toBeUndefined()
    })

    test('should not throw if conversation not found', async () => {
      const fakeId = '000000000000000000000000'
      await expect(JobHandlers.autoStartConversation({ attrs: { data: { conversationId: fakeId } } })).resolves.not.toThrow()
    })
  })

  describe('autoStopConversation', () => {
    beforeEach(async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: true, startTime: new Date() })
    })

    test('should stop an active conversation', async () => {
      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })

    test('should skip if conversation is already inactive', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: false })

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.endTime).toBeUndefined()
    })

    test('should not throw if conversation not found', async () => {
      const fakeId = '000000000000000000000000'
      await expect(JobHandlers.autoStopConversation({ attrs: { data: { conversationId: fakeId } } })).resolves.not.toThrow()
    })
  })

  describe('conversationEndingSoon', () => {
    beforeEach(async () => {})

    test('should call conversation ending soon job', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, {
        active: true,
        startTime: new Date(),
        scheduledEndTime: new Date(Date.now() + 20 * 60 * 1000)
      }) // scheduled to end in 20 minutes
      const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastConversationAlmostEnding')

      await JobHandlers.conversationEndingSoon({ attrs: { data: { conversationId: conversation._id } } })

      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }))
    })
  })
})
