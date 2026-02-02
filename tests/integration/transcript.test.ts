import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo, registeredUser } from '../fixtures/user.fixture.js'
import { userOneAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { Conversation, Agent, Message } from '../../src/models/index.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { publicTopic, privateTopic } from '../fixtures/conversation.fixture.js'

import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import rag, { TRANSCRIPT_COLLECTION_PREFIX } from '../../src/agents/helpers/rag.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'

jest.setTimeout(120000)

const testAgentTypeSpecification = {
  test: {
    initialize: jest.fn(),
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
    defaultLLMModel,
    useTranscriptRAGCollection: true
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
    await insertUsers([userOne, userTwo, registeredUser])
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

      const ragAgent = new Agent({
        agentType: 'test',
        conversation: conversation._id,
        useTranscriptRAGCollection: true
      })
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

    test('should return 204 and not touch RAG when conversation has no RAG-enabled agents', async () => {
      const removeFromVectorStoreSpy = jest.spyOn(rag, 'removeFromVectorStore').mockResolvedValue()

      // Create conversation without RAG-enabled agents
      const conversation = new Conversation({
        name: 'No RAG Conversation',
        owner: userOne._id,
        topic: publicTopic._id,
        agents: [],
        messages: [],
        transcript: { status: 'stopped' }
      })
      await conversation.save()

      // Create agent without RAG
      const agent = new Agent({
        agentType: 'test',
        conversation: conversation._id,
        useTranscriptRAGCollection: false
      })
      await agent.save()

      conversation.agents = [agent]
      await conversation.save()

      // Create transcript message
      const transcriptMessage = new Message({
        conversation: conversation._id,
        body: 'Non-RAG transcript message',
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

      // Verify RAG was not touched
      expect(removeFromVectorStoreSpy).not.toHaveBeenCalled()

      // Verify messages are still deleted
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

      const ragAgent = new Agent({
        agentType: 'test',
        conversation: conversation._id,
        useTranscriptRAGCollection: true
      })
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
  })
})
