import mongoose from 'mongoose'
import { Conversation, Message } from '../../../src/models/index.js'
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

    /* draft: false because this describes start/stop mechanics, not draft-status behavior;
       conversationOne itself has no scheduledTime/zoomMeetingUrl, which would otherwise
       default it to Draft and block it from starting. */
    conversation = new Conversation({ ...conversationOne, active: false, draft: false })
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

    test('should not start a Draft conversation, and should not throw out of the job', async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { draft: true })

      await expect(
        JobHandlers.autoStartConversation({ attrs: { data: { conversationId: conversation._id } } })
      ).resolves.not.toThrow()

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.startTime).toBeUndefined()
    })
  })

  describe('autoStopConversation', () => {
    const startedLongAgo = new Date(Date.now() - 20 * 60 * 1000) // 20 min ago, past NEVER_STARTED_TIMEOUT_MS

    beforeEach(async () => {
      await Conversation.findByIdAndUpdate(conversation._id, { active: true, startTime: startedLongAgo })
    })

    test('stops when no transcript messages exist (never-started case)', async () => {
      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })

    test('stops when last transcript message is older than IDLE_TIMEOUT_MS', async () => {
      await Message.create({
        conversation: conversation._id,
        channels: ['transcript'],
        body: 'hello',
        pseudonym: 'Speaker',
        pseudonymId: new mongoose.Types.ObjectId(),
        createdAt: new Date(Date.now() - 6 * 60 * 1000) // 6 min ago
      })

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
    })

    test('does not stop when a recent transcript message exists', async () => {
      await Message.create({
        conversation: conversation._id,
        channels: ['transcript'],
        body: 'hello',
        pseudonym: 'Speaker',
        pseudonymId: new mongoose.Types.ObjectId(),
        createdAt: new Date(Date.now() - 60 * 1000) // 1 min ago
      })

      await JobHandlers.autoStopConversation({ attrs: { data: { conversationId: conversation._id } } })

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(true)
      expect(updated!.endTime).toBeUndefined()
    })

    test('does not throw if conversation not found', async () => {
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
      const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastConversationAlmostEnding').mockResolvedValue(undefined)

      await JobHandlers.conversationEndingSoon({ attrs: { data: { conversationId: conversation._id } } })

      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }))
    })
  })
})
