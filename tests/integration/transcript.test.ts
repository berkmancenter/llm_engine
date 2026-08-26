import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo, registeredUser, participant } from '../fixtures/user.fixture.js'
import { userOneAccessToken, participantAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { Conversation, Agent, Channel, Message } from '../../src/models/index.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { publicTopic, privateTopic } from '../fixtures/conversation.fixture.js'

import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from '../../src/agents/helpers/rag.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'

jest.setTimeout(120000)

const testAgentTypeSpecification = {
  test: {
    respond: jest.fn(),
    evaluate: jest.fn(),
    isWithinTokenLimit: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    name: 'Test Agent',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessage: 2 } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  }
}

jest.mock('agenda')
setupIntTest()

describe('Transcript routes', () => {
  let broadcastTranscriptStatusChangeSpy

  beforeAll(() => {
    setAgentTypes(testAgentTypeSpecification)
  })

  beforeEach(async () => {
    await insertUsers([userOne, userTwo, registeredUser, participant])
    await insertTopics([publicTopic, privateTopic])
    broadcastTranscriptStatusChangeSpy = jest.spyOn(websocketGateway, 'broadcastTranscriptStatusChange').mockResolvedValue()
  })

  afterEach(() => {
    if (broadcastTranscriptStatusChangeSpy) {
      broadcastTranscriptStatusChangeSpy.mockRestore()
    }
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })

  describe('DELETE /v1/transcript/:conversationId', () => {
    test('should return 204 and delete transcript messages when user is conversation owner', async () => {
      // Create a conversation with transcript messages
      const conversation = new Conversation({
        name: 'Test Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Create transcript messages
      const transcriptMessage1 = new Message({
        conversation: conversation._id,
        body: 'This is a transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage1.save()

      const transcriptMessage2 = new Message({
        conversation: conversation._id,
        body: 'Another transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage2.save()

      // Create a non-transcript message (should NOT be deleted)
      const regularMessage = new Message({
        conversation: conversation._id,
        body: 'Regular message',
        channels: ['general'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await regularMessage.save()

      // Verify messages exist before deletion
      const messagesBefore = await Message.find({ conversation: conversation._id })
      expect(messagesBefore).toHaveLength(3)

      const transcriptMessagesBefore = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesBefore).toHaveLength(2)

      // Delete transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify transcript messages are deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      // Verify regular message still exists
      const regularMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['general'] }
      })
      expect(regularMessagesAfter).toHaveLength(1)
      expect(regularMessagesAfter[0]._id.toString()).toBe(regularMessage._id.toString())
    })

    test('should return 204 and delete transcript messages when user is topic owner', async () => {
      // Create a conversation owned by userTwo but in userOne's topic
      const conversation = new Conversation({
        name: 'Topic Owner Test',
        owner: userTwo._id,
        topic: publicTopic._id, // publicTopic is owned by userOne
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Delete transcript as topic owner (userOne)
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify transcript message is deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)
    })

    test('should return 204 and clear transcript content from RAG (preserve metadata) when conversation has RAG-enabled agent', async () => {
      const removeFromVectorStoreSpy = jest.spyOn(rag, 'removeFromVectorStore').mockResolvedValue()

      // Create conversation with RAG-enabled agent
      const conversation = new Conversation({
        name: 'RAG Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      const ragAgent = new Agent({ agentType: 'test', conversation: conversation._id })
      await ragAgent.save()

      conversation.agents = [ragAgent]
      await conversation.save()

      // Create transcript messages
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'RAG transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Delete transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify only transcript content was removed (not entire collection)
      expect(removeFromVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`, {
        type: 'transcript'
      })

      // Verify messages are deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      removeFromVectorStoreSpy.mockRestore()
    })

    test('should return 204 when deleting transcript with no messages', async () => {
      // Create conversation without transcript messages
      const conversation = new Conversation({
        name: 'Empty Transcript Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Delete transcript (should succeed even with no messages)
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify no messages exist
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .delete(`/v1/transcript/${nonExistentId}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      const conversation = new Conversation({
        name: 'Unauthorized Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      await request(app).delete(`/v1/transcript/${conversation._id}`).send().expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .delete('/v1/transcript/invalid-id')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should handle RAG clear failure gracefully', async () => {
      const removeFromVectorStoreSpy = jest
        .spyOn(rag, 'removeFromVectorStore')
        .mockRejectedValue(new Error('RAG clear failed'))

      // Create conversation with RAG-enabled agent
      const conversation = new Conversation({
        name: 'RAG Failure Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      const ragAgent = new Agent({ agentType: 'test', conversation: conversation._id })
      await ragAgent.save()

      conversation.agents = [ragAgent]
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'RAG failure message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Delete transcript should return 204 even if RAG clear fails
      // The function handles the error gracefully and continues to delete messages
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify RAG clear was attempted
      expect(removeFromVectorStoreSpy).toHaveBeenCalledWith(`${TRANSCRIPT_COLLECTION_PREFIX}-${conversation._id}`, {
        type: 'transcript'
      })

      // Verify messages are still deleted despite RAG failure
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      removeFromVectorStoreSpy.mockRestore()
    })

    test('should delete only messages in transcript channel, preserving messages in other channels', async () => {
      const conversation = new Conversation({
        name: 'Multi-Channel Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Create messages in various channels
      const transcriptMsg = new Message({
        conversation: conversation._id,
        body: 'Transcript only',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMsg.save()

      const multiChannelMsg = new Message({
        conversation: conversation._id,
        body: 'Multiple channels',
        channels: ['transcript', 'general'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await multiChannelMsg.save()

      const generalMsg = new Message({
        conversation: conversation._id,
        body: 'General only',
        channels: ['general'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await generalMsg.save()

      // Verify initial state
      const allMessagesBefore = await Message.find({ conversation: conversation._id })
      expect(allMessagesBefore).toHaveLength(3)

      // Delete transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify only transcript-channel messages are deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      // Verify general-only message still exists
      const generalMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['general'] }
      })
      expect(generalMessagesAfter).toHaveLength(1)
      expect(generalMessagesAfter[0]._id.toString()).toBe(generalMsg._id.toString())
    })

    test('should return 400 when trying to delete an active transcript', async () => {
      const conversation = new Conversation({
        name: 'Active Transcript Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Active transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Try to delete active transcript
      const response = await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)

      expect(response.body.message).toContain('Cannot delete an active transcript')

      // Verify message still exists
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(1)

      // Verify transcript status is still active
      const updatedConversation = await Conversation.findById(conversation._id)
      expect(updatedConversation!.transcript?.status).toBe('active')
    })

    test('should return 204 when deleting an already stopped transcript', async () => {
      const conversation = new Conversation({
        name: 'Stopped Transcript Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Stopped transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Delete stopped transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify messages are deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      // Verify transcript status changes to deleted
      const updatedConversation = await Conversation.findById(conversation._id)
      expect(updatedConversation!.transcript?.status).toBe('deleted')
    })

    test('should return 204 when deleting a paused transcript', async () => {
      const conversation = new Conversation({
        name: 'Paused Transcript Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'paused' }
      })
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Paused transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Delete paused transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify messages are deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      // Verify transcript status changes to deleted
      const updatedConversation = await Conversation.findById(conversation._id)
      expect(updatedConversation!.transcript?.status).toBe('deleted')
    })

    test('should broadcast transcript status change when deleting transcript', async () => {
      const conversation = new Conversation({
        name: 'Broadcast Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Delete transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify broadcast was called with 'deleted' status
      expect(broadcastTranscriptStatusChangeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: conversation._id }),
        'deleted'
      )
    })
    test('should return 204 and set status to deleted when deleting a paused transcript', async () => {
      const conversation = new Conversation({
        name: 'Paused Transcript Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'paused' }
      })
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Paused transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await transcriptMessage.save()

      // Delete paused transcript
      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify messages are deleted
      const transcriptMessagesAfter = await Message.find({
        conversation: conversation._id,
        channels: { $in: ['transcript'] }
      })
      expect(transcriptMessagesAfter).toHaveLength(0)

      // Verify transcript status is set to deleted
      const updatedConversation = await Conversation.findById(conversation._id)
      expect(updatedConversation!.transcript?.status).toBe('deleted')
    })
  })

  describe('POST /v1/transcript/:conversationId/pause', () => {
    test('should return 204 and call pause on adapters', async () => {
      // Create a conversation with an active transcript
      const conversation = new Conversation({
        name: 'Pause Test Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Pause transcript
      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })

    test('should call pauseRecording on all adapters', async () => {
      const adapterService = await import('../../src/services/adapter.service.js')
      const pauseRecordingSpy = jest.spyOn(adapterService.default, 'pauseRecording').mockResolvedValue()

      const conversation = new Conversation({
        name: 'Multiple Adapters Pause Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create mock adapters
      const { default: Adapter } = await import('../../src/models/adapter.model.js')
      const adapter1 = new Adapter({
        type: 'zoom',
        conversation: conversation._id,
        config: { meetingUrl: 'https://zoom.us/j/123' }
      })
      await adapter1.save()

      const adapter2 = new Adapter({
        type: 'zoom',
        conversation: conversation._id,
        config: { meetingUrl: 'https://zoom.us/j/456' }
      })
      await adapter2.save()

      conversation.adapters = [adapter1, adapter2]
      await conversation.save()

      // Pause transcript
      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify pauseRecording was called for each adapter
      expect(pauseRecordingSpy).toHaveBeenCalledTimes(2)
      expect(pauseRecordingSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: adapter1._id }))
      expect(pauseRecordingSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: adapter2._id }))

      pauseRecordingSpy.mockRestore()
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .post(`/v1/transcript/${nonExistentId}/pause`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      const conversation = new Conversation({
        name: 'Unauthorized Pause Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      await request(app).post(`/v1/transcript/${conversation._id}/pause`).send().expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .post('/v1/transcript/invalid-id/pause')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 when conversation has no transcript configured', async () => {
      const conversation = new Conversation({
        name: 'No Transcript Pause Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: []
        // No transcript field
      })
      await conversation.save()

      const response = await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)

      expect(response.body.message).toContain('No transcript configured')
    })

    test('should successfully pause an already paused transcript', async () => {
      const conversation = new Conversation({
        name: 'Already Paused Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'paused' }
      })
      await conversation.save()

      // Should succeed even if already paused
      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })
  })

  describe('GET /v1/transcript/:conversationId', () => {
    test('should return 200 and plain text transcript with multiple messages', async () => {
      // Create a conversation with transcript messages
      const conversation = new Conversation({
        name: 'Get Transcript Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create transcript messages with specific times
      const time1 = new Date('2024-01-01T10:15:30Z')
      const time2 = new Date('2024-01-01T10:16:45Z')
      const time3 = new Date('2024-01-01T10:17:20Z')

      const message1 = new Message({
        conversation: conversation._id,
        body: 'First transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: time1
      })
      await message1.save()

      const message2 = new Message({
        conversation: conversation._id,
        body: 'Second transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: time2
      })
      await message2.save()

      const message3 = new Message({
        conversation: conversation._id,
        body: 'Third transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: time3
      })
      await message3.save()

      // Get transcript
      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.OK)

      // Verify response is plain text
      expect(response.headers['content-type']).toMatch(/text\/plain/)

      // Verify format: [HH:MM:SS] message body (one per line)
      const lines = response.text.split('\n')
      expect(lines).toHaveLength(3)
      expect(lines[0]).toMatch(/\[\d{1,2}:\d{2}:\d{2} (AM|PM)\] First transcript message/)
      expect(lines[1]).toMatch(/\[\d{1,2}:\d{2}:\d{2} (AM|PM)\] Second transcript message/)
      expect(lines[2]).toMatch(/\[\d{1,2}:\d{2}:\d{2} (AM|PM)\] Third transcript message/)
    })

    test('should return 200 and empty string when conversation has no transcript messages', async () => {
      // Create conversation without transcript messages
      const conversation = new Conversation({
        name: 'Empty Transcript Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Get transcript
      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.OK)

      // Verify response is empty
      expect(response.text).toBe('')
    })

    test('should only include messages in transcript channel', async () => {
      const conversation = new Conversation({
        name: 'Channel Filter Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create messages in different channels
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Transcript message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:15:00Z')
      })
      await transcriptMessage.save()

      const generalMessage = new Message({
        conversation: conversation._id,
        body: 'General message',
        channels: ['general'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:16:00Z')
      })
      await generalMessage.save()

      // Get transcript
      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.OK)

      // Verify only transcript message is included
      const lines = response.text.split('\n').filter((line) => line.trim() !== '')
      expect(lines).toHaveLength(1)
      expect(response.text).toContain('Transcript message')
      expect(response.text).not.toContain('General message')
    })

    test('should include messages that are in multiple channels including transcript', async () => {
      const conversation = new Conversation({
        name: 'Multi-Channel Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create a message in both transcript and general channels
      const multiChannelMessage = new Message({
        conversation: conversation._id,
        body: 'Multi-channel message',
        channels: ['transcript', 'general'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:15:00Z')
      })
      await multiChannelMessage.save()

      // Get transcript
      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.OK)

      // Verify multi-channel message is included
      expect(response.text).toContain('Multi-channel message')
    })

    test('should return messages sorted by createdAt in ascending order', async () => {
      const conversation = new Conversation({
        name: 'Sorting Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create messages out of order
      const message3 = new Message({
        conversation: conversation._id,
        body: 'Third message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:17:00Z')
      })
      await message3.save()

      const message1 = new Message({
        conversation: conversation._id,
        body: 'First message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:15:00Z')
      })
      await message1.save()

      const message2 = new Message({
        conversation: conversation._id,
        body: 'Second message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:16:00Z')
      })
      await message2.save()

      // Get transcript
      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.OK)

      // Verify messages are in correct order
      const lines = response.text.split('\n')
      expect(lines[0]).toContain('First message')
      expect(lines[1]).toContain('Second message')
      expect(lines[2]).toContain('Third message')
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .get(`/v1/transcript/${nonExistentId}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      const conversation = new Conversation({
        name: 'Unauthorized Get Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .get('/v1/transcript/invalid-id')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 406 when Accept header is not text/plain', async () => {
      const conversation = new Conversation({
        name: 'Accept Header Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'application/json')
        .send()
        .expect(httpStatus.NOT_ACCEPTABLE)
    })

    test('should return 200 with default Accept header (text/plain implied)', async () => {
      const conversation = new Conversation({
        name: 'Default Accept Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      const message = new Message({
        conversation: conversation._id,
        body: 'Test message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-01T10:15:00Z')
      })
      await message.save()

      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(response.text).toContain('Test message')
    })

    test('should format timestamps in UTC by default', async () => {
      const conversation = new Conversation({
        name: 'Default Timezone Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create message at 14:30 UTC
      const message = new Message({
        conversation: conversation._id,
        body: 'UTC timezone message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-15T14:30:45Z')
      })
      await message.save()

      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .send()
        .expect(httpStatus.OK)

      // Should be formatted in UTC: 2:30:45 PM
      expect(response.text).toContain('[2:30:45 PM] UTC timezone message')
    })

    test('should format timestamps in America/New_York timezone when X-Timezone header is provided', async () => {
      const conversation = new Conversation({
        name: 'EST Timezone Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create message at 14:30 UTC (which is 9:30 AM EST, UTC-5)
      const message = new Message({
        conversation: conversation._id,
        body: 'EST timezone message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-15T14:30:45Z')
      })
      await message.save()

      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .set('X-Timezone', 'America/New_York')
        .send()
        .expect(httpStatus.OK)

      // Should be formatted in EST: 9:30:45 AM
      expect(response.text).toContain('[9:30:45 AM] EST timezone message')
    })

    test('should format timestamps in Asia/Tokyo timezone when X-Timezone header is provided', async () => {
      const conversation = new Conversation({
        name: 'Tokyo Timezone Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create message at 15:00 UTC (which is 00:00 JST next day, UTC+9)
      const message = new Message({
        conversation: conversation._id,
        body: 'Tokyo timezone message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-15T15:00:00Z')
      })
      await message.save()

      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .set('X-Timezone', 'Asia/Tokyo')
        .send()
        .expect(httpStatus.OK)

      // Should be formatted in JST: 12:00:00 AM (midnight)
      expect(response.text).toContain('[12:00:00 AM] Tokyo timezone message')
    })

    test('should format multiple messages with correct timezone offsets', async () => {
      const conversation = new Conversation({
        name: 'Multiple Messages Timezone Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Create messages at different UTC times
      const message1 = new Message({
        conversation: conversation._id,
        body: 'First message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-15T14:00:00Z') // 9:00 AM EST
      })
      await message1.save()

      const message2 = new Message({
        conversation: conversation._id,
        body: 'Second message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-15T19:30:00Z') // 2:30 PM EST
      })
      await message2.save()

      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .set('X-Timezone', 'America/New_York')
        .send()
        .expect(httpStatus.OK)

      expect(response.text).toContain('[9:00:00 AM] First message')
      expect(response.text).toContain('[2:30:00 PM] Second message')
    })

    test('should handle invalid timezone gracefully by using it as-is', async () => {
      const conversation = new Conversation({
        name: 'Invalid Timezone Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'active' }
      })
      await conversation.save()

      const message = new Message({
        conversation: conversation._id,
        body: 'Test message',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date('2024-01-15T14:30:00Z')
      })
      await message.save()

      // Pass an invalid timezone - JavaScript's toLocaleTimeString will throw
      const response = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .set('Accept', 'text/plain')
        .set('X-Timezone', 'Invalid/Timezone')
        .send()

      // The request should fail with an error (toLocaleTimeString will throw on invalid timezone)
      expect([httpStatus.INTERNAL_SERVER_ERROR, httpStatus.BAD_REQUEST]).toContain(response.status)
    })
  })

  describe('POST /v1/transcript/:conversationId/resume', () => {
    test('should return 204 and call resume on adapters', async () => {
      // Create a conversation with a paused transcript
      const conversation = new Conversation({
        name: 'Resume Test Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        transcript: { status: 'paused' }
      })
      await conversation.save()

      // Resume transcript
      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })

    test('should call resumeRecording on all adapters', async () => {
      const adapterService = await import('../../src/services/adapter.service.js')
      const resumeRecordingSpy = jest.spyOn(adapterService.default, 'resumeRecording').mockResolvedValue()

      const conversation = new Conversation({
        name: 'Multiple Adapters Resume Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        transcript: { status: 'paused' }
      })
      await conversation.save()

      // Create mock adapters
      const { default: Adapter } = await import('../../src/models/adapter.model.js')
      const adapter1 = new Adapter({
        type: 'zoom',
        conversation: conversation._id,
        config: { meetingUrl: 'https://zoom.us/j/123' }
      })
      await adapter1.save()

      const adapter2 = new Adapter({
        type: 'zoom',
        conversation: conversation._id,
        config: { meetingUrl: 'https://zoom.us/j/456' }
      })
      await adapter2.save()

      conversation.adapters = [adapter1, adapter2]
      await conversation.save()

      // Resume transcript
      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify resumeRecording was called for each adapter
      expect(resumeRecordingSpy).toHaveBeenCalledTimes(2)
      expect(resumeRecordingSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: adapter1._id }))
      expect(resumeRecordingSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: adapter2._id }))

      resumeRecordingSpy.mockRestore()
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .post(`/v1/transcript/${nonExistentId}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      const conversation = new Conversation({
        name: 'Unauthorized Resume Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        transcript: { status: 'paused' }
      })
      await conversation.save()

      await request(app).post(`/v1/transcript/${conversation._id}/resume`).send().expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .post('/v1/transcript/invalid-id/resume')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 when conversation has no transcript configured', async () => {
      const conversation = new Conversation({
        name: 'No Transcript Resume Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true
        // No transcript field
      })
      await conversation.save()

      const response = await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)

      expect(response.body.message).toContain('No transcript configured')
    })

    test('should start conversation and return 204 when resuming transcript for an inactive conversation', async () => {
      const conversationService = await import('../../src/services/conversation.service/index.js')
      const startConversationSpy = jest.spyOn(conversationService.default, 'startConversation').mockResolvedValue({})

      const conversation = new Conversation({
        name: 'Inactive Conversation Resume Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: false,
        transcript: { status: 'paused' }
      })
      await conversation.save()

      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)

      // Verify startConversation was called to activate the inactive conversation
      expect(startConversationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ _id: conversation._id }),
        expect.anything()
      )

      startConversationSpy.mockRestore()
    })

    test('should successfully resume an already active transcript', async () => {
      const conversation = new Conversation({
        name: 'Already Active Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        transcript: { status: 'active' }
      })
      await conversation.save()

      // Should succeed even if already active
      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })

    test('should successfully resume a stopped transcript', async () => {
      const conversation = new Conversation({
        name: 'Resume Stopped Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Should be able to resume a stopped transcript
      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })
  })
  /* A moderator reaches an event through a link carrying the moderator channel's passcode and
     nothing else: the throwaway account it creates is an ordinary participant. These cover the
     passcode route into the four controls, alongside the admin route the tests above use. */
  describe('transcript controls with a moderator passcode', () => {
    const MODERATOR_PASSCODE = 'mod_PASSCODE_1'
    const TRANSCRIPT_PASSCODE = 'transcript_PASSCODE_1'

    /* Builds an event shaped like the ones moderators are sent to: a moderator channel whose
       passcode only they receive, and a transcript channel whose passcode rides along in every
       participant's link too. */
    const createEventWithChannels = async (overrides = {}) => {
      const moderatorChannel = await new Channel({ name: 'moderator', passcode: MODERATOR_PASSCODE }).save()
      const transcriptChannel = await new Channel({ name: 'transcript', passcode: TRANSCRIPT_PASSCODE }).save()
      const conversation = new Conversation({
        name: 'Moderator Passcode Test',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        channels: [moderatorChannel._id, transcriptChannel._id],
        transcript: { status: 'active' },
        ...overrides
      })
      await conversation.save()
      return conversation
    }

    test('pauses when the request carries the moderator passcode', async () => {
      const conversation = await createEventWithChannels()

      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .query({ channel: `moderator,${MODERATOR_PASSCODE}` })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })

    test('resumes an active event when the request carries the moderator passcode', async () => {
      const conversation = await createEventWithChannels({ transcript: { status: 'paused' } })

      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .query({ channel: `moderator,${MODERATOR_PASSCODE}` })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })

    test('downloads the transcript when the request carries the moderator passcode', async () => {
      const conversation = await createEventWithChannels()
      const message = new Message({
        conversation: conversation._id,
        body: 'Recorded line',
        channels: ['transcript'],
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        createdAt: new Date()
      })
      await message.save()

      const res = await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .query({ channel: `moderator,${MODERATOR_PASSCODE}` })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .set('Accept', 'text/plain')
        .expect(httpStatus.OK)

      expect(res.text).toContain('Recorded line')
    })

    test('deletes the transcript when the request carries the moderator passcode', async () => {
      const conversation = await createEventWithChannels({ transcript: { status: 'paused' } })

      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .query({ channel: `moderator,${MODERATOR_PASSCODE}` })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })

    // Every participant's link carries this one, so it must not unlock the controls.
    test('refuses the transcript passcode in place of the moderator one', async () => {
      const conversation = await createEventWithChannels()

      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .query({ channel: `transcript,${TRANSCRIPT_PASSCODE}` })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)
    })

    test('refuses a wrong moderator passcode', async () => {
      const conversation = await createEventWithChannels()

      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .query({ channel: 'moderator,not-the-passcode' })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)
    })

    test('refuses a request with no passcode at all', async () => {
      const conversation = await createEventWithChannels()

      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)
    })

    test('refuses every control, not just pause, without the moderator passcode', async () => {
      const conversation = await createEventWithChannels({ transcript: { status: 'paused' } })

      await request(app)
        .post(`/v1/transcript/${conversation._id}/resume`)
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)

      await request(app)
        .get(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .set('Accept', 'text/plain')
        .expect(httpStatus.FORBIDDEN)

      await request(app)
        .delete(`/v1/transcript/${conversation._id}`)
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)
    })

    /* An event with moderator support switched off has no passcode to check, so the controls
       fall back to admins only. The refusal should say that rather than blame the passcode
       the caller sent, which would send them hunting for a link that cannot exist. */
    test('says only an administrator can control it, rather than reporting a bad passcode', async () => {
      const conversation = new Conversation({
        name: 'No Moderator Channel',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        active: true,
        transcript: { status: 'active' }
      })
      await conversation.save()

      const res = await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .query({ channel: `moderator,${MODERATOR_PASSCODE}` })
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)

      expect(res.body.message).toMatch(/only an administrator/i)
      expect(res.body.message).not.toMatch(/incorrect/i)
    })

    test('still lets an admin work with no passcode at all', async () => {
      const conversation = await createEventWithChannels()

      await request(app)
        .post(`/v1/transcript/${conversation._id}/pause`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NO_CONTENT)
    })
  })
})
