import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import {
  messageOne,
  insertMessages,
  messagePost,
  messageChannelCorrect,
  messageChannelIncorrect,
  visibleMessageTC,
  invisibleMessageTC,
  visibleChannelMessageTC,
  invisibleChannelMessageTC,
  messageChannelDirect
} from '../fixtures/message.fixture.js'

import app from '../../src/app.js'
import { insertUsers, registeredUser, userOne } from '../fixtures/user.fixture.js'
import { registeredUserAccessToken, userOneAccessToken } from '../fixtures/token.fixture.js'
import Message from '../../src/models/message.model.js'
import { insertTopics, newPublicTopic } from '../fixtures/topic.fixture.js'
import {
  conversationOne,
  insertConversations,
  conversationWithChannels,
  insertChannels
} from '../fixtures/conversation.fixture.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'

jest.mock('agenda')
jest.setTimeout(30000)
setupIntTest()
const publicTopic = newPublicTopic()

describe('Message routes', () => {
  describe('POST /v1/messages/:conversationId/vote', () => {
    test('should return 200 and increment upVote count for message', async () => {
      await insertUsers([registeredUser, userOne])
      await insertMessages([messageOne])
      jest.spyOn(websocketGateway, 'broadcastNewVote').mockResolvedValue()

      const ret = await request(app)
        .post(`/v1/messages/${messageOne._id}/vote`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.OK)

      expect(ret.body.upVotes).toHaveLength(1)
      expect(ret.body.downVotes).toBeDefined()

      const msg = await Message.findById(messageOne._id)
      expect(msg).toBeTruthy()
      expect(msg!.upVotes).toHaveLength(1)
    })

    test('should return 400 because user cannot vote for their own message', async () => {
      await insertUsers([registeredUser])
      await insertMessages([messageOne])
      await request(app)
        .post(`/v1/messages/${messageOne._id}/vote`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 because user cant downvote after upvoting', async () => {
      await insertUsers([registeredUser, userOne])
      await insertMessages([messageOne])
      jest.spyOn(websocketGateway, 'broadcastNewVote').mockResolvedValue()
      await request(app)
        .post(`/v1/messages/${messageOne._id}/vote`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.OK)

      await request(app)
        .post(`/v1/messages/${messageOne._id}/vote`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ status: true, direction: 'down' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 because user has already upvoted for message', async () => {
      await insertUsers([registeredUser, userOne])
      await insertMessages([messageOne])
      jest.spyOn(websocketGateway, 'broadcastNewVote').mockResolvedValue()
      await request(app)
        .post(`/v1/messages/${messageOne._id}/vote`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.OK)

      await request(app)
        .post(`/v1/messages/${messageOne._id}/vote`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ status: true, direction: 'up' })
        .expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('POST /v1/messages', () => {
    test('a message with text body type should return 201 and create message', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])
      await insertConversations([conversationOne])
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      const res = await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(messagePost)
        .expect(httpStatus.CREATED)

      const msgs = await Message.find({ id: res.id })
      expect(msgs).toHaveLength(1)

      const msgsFromBody = await Message.find({ body: messagePost.body })
      expect(msgsFromBody).toHaveLength(1)
      expect(msgsFromBody[0].bodyType).toEqual('text')
    })

    test('a message with a JSON object body type should return 201 and create message', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])
      await insertConversations([conversationOne])
      const msgPostObjBody = {
        body: { text: 'foo', user: 'bar' },
        conversation: conversationOne._id,
        bodyType: 'json'
      }
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      const res = await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(msgPostObjBody)
        .expect(httpStatus.CREATED)

      const msgs = await Message.find({ id: res.id })
      expect(msgs).toHaveLength(1)

      const msgsFromBody = await Message.find({ body: msgPostObjBody.body })
      expect(msgsFromBody).toHaveLength(1)
      expect(msgsFromBody[0].bodyType).toEqual('json')
    })

    test('a message with an invalid body type should return a 400', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])
      await insertConversations([conversationOne])
      const msgPostObjBody = {
        body: { text: 'foo', user: 'bar' },
        conversation: conversationOne._id,
        bodyType: 'video'
      }
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(msgPostObjBody)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should create message, and message should have current active pseudonym', async () => {
      const userRet = await insertUsers([registeredUser])
      await insertTopics([publicTopic])
      await insertConversations([conversationOne])
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      const res = await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(messagePost)
        .expect(httpStatus.CREATED)

      const msgs = await Message.find({ id: res.id })
      expect(msgs[0].pseudonymId).toEqual(userRet[0].pseudonyms[0]._id)
    })

    test('a message with channel but incorrect passcode return 400 and not create message', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])
      const channels = await insertChannels(conversationWithChannels.channels)
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])
      await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(messageChannelIncorrect)
        .expect(httpStatus.BAD_REQUEST)

      const msgs = await Message.find({ body: messageChannelIncorrect.body })
      expect(msgs).toHaveLength(0)
    })

    test('a message with channel and correct passcode should return 201 and create message', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])

      const channels = await insertChannels(conversationWithChannels.channels)
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      const res = await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(messageChannelCorrect)
        .expect(httpStatus.CREATED)

      const msgs = await Message.find({ id: res.id })
      expect(msgs).toHaveLength(1)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query: any = {
        body: messageChannelCorrect.body,
        channels: { $size: 1 }
      }

      const msgsFromBody = await Message.find(query)
      expect(msgsFromBody).toHaveLength(1)
    })
    test('a message with channel that has no passcode should return 201 and create message', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])

      const channels = await insertChannels(conversationWithChannels.channels)
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      const res = await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(messageChannelDirect)
        .expect(httpStatus.CREATED)

      const msgs = await Message.find({ id: res.id })
      expect(msgs).toHaveLength(1)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query: any = {
        body: messageChannelDirect.body,
        channels: { $size: 1 }
      }

      const msgsFromBody = await Message.find(query)
      expect(msgsFromBody).toHaveLength(1)
    })
    test('a message with direct channel that does not include the requesting user as participant should return 401 and not create message', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])

      const channels = await insertChannels([
        {
          name: 'channel3',
          passcode: null,
          direct: true,
          participants: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
        }
      ])
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await request(app)
        .post(`/v1/messages/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(messageChannelDirect)
        .expect(httpStatus.UNAUTHORIZED)
    })
  })

  describe('GET /v1/messages/:conversationId', () => {
    test('a request without channels should return 200 and body should be all visible messages without channels for a conversation', async () => {
      await insertMessages([visibleMessageTC, invisibleMessageTC, visibleChannelMessageTC, invisibleChannelMessageTC])
      conversationWithChannels.messages = [
        visibleMessageTC,
        invisibleMessageTC,
        visibleChannelMessageTC,
        invisibleChannelMessageTC
      ]

      const channels = await insertChannels(conversationWithChannels.channels)
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])

      const resp = await request(app)
        .get(`/v1/messages/${conversationWithChannels._id.toString()}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(1)
      expect(resp.body[0].id).toBe(visibleMessageTC._id.toString())
    })

    test('a request with channels should return 200 and body should be all visible messages without a channel or with specified channels for a conversation', async () => {
      await insertMessages([visibleMessageTC, invisibleMessageTC, visibleChannelMessageTC, invisibleChannelMessageTC])
      conversationWithChannels.messages = [
        visibleMessageTC,
        invisibleMessageTC,
        visibleChannelMessageTC,
        invisibleChannelMessageTC
      ]

      const channels = await insertChannels(conversationWithChannels.channels)
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])

      const resp = await request(app)
        .get(`/v1/messages/${conversationWithChannels._id.toString()}?channel=channel2, channel2_CODE`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(2)
      expect(resp.body[0].id).toBe(visibleMessageTC._id.toString())
      expect(resp.body[1].id).toBe(visibleChannelMessageTC._id.toString())
    })
  })
})
