import request from 'supertest'
import httpStatus from 'http-status'
import faker from 'faker'
import slugify from 'slugify'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, registeredUser, userOne } from '../fixtures/user.fixture.js'
import { registeredUserAccessToken, userOneAccessToken } from '../fixtures/token.fixture.js'
import { topicPost, newPublicTopic, newPrivateTopic, insertTopics, getRandomInt } from '../fixtures/topic.fixture.js'
import { tokenService } from '../../src/services/index.js'
import Topic from '../../src/models/topic.model.js'
import tokenTypes from '../../src/config/tokens.js'
import Token from '../../src/models/token.model.js'
import { insertFollowers } from '../fixtures/follower.fixture.js'
import { conversationThree, insertConversations } from '../fixtures/conversation.fixture.js'
import { messageFour, invisibleMessage, insertMessages } from '../fixtures/message.fixture.js'

setupIntTest()

const publicTopic = newPublicTopic()
const privateTopic = newPrivateTopic()

describe('Topic routes', () => {
  describe('POST /v1/topics/', () => {
    test('should return 201 and create a topic', async () => {
      await insertUsers([registeredUser])
      await request(app)
        .post(`/v1/topics`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(topicPost)
        .expect(httpStatus.CREATED)
    })

    test('should return 400 if missing a required field', async () => {
      await insertUsers([registeredUser])

      await request(app)
        .post(`/v1/topics`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          name: 'fadfjaldkfj',
          votingAllowed: true,
          conversationCreationAllowed: true,
          private: undefined,
          archivable: true,
          archiveEmail: faker.internet.email()
        })
        .expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('DELETE /v1/topics/:topicId', () => {
    test('should return 200 and soft delete a topic', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic, privateTopic])
      await request(app)
        .delete(`/v1/topics/${privateTopic._id}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      const topicDoc = await Topic.findOne({ _id: privateTopic._id })
      expect(topicDoc).toBeTruthy()
      expect(topicDoc!.isDeleted).toBe(true)
    })

    test('should return 400 if missing topic id', async () => {
      await request(app)
        .delete(`/v1/topics/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 404 if topic is not found', async () => {
      await insertUsers([registeredUser])
      await request(app)
        .delete(`/v1/topics/${privateTopic._id}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })
  })

  describe('PUT /v1/topics/', () => {
    test('should return 200 and update topic using merge strategy', async () => {
      await insertUsers([registeredUser])
      await insertTopics([publicTopic])
      await request(app)
        .put(`/v1/topics/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({ id: publicTopic._id, name: 'favorite dogs', archivable: true })
        .expect(httpStatus.OK)

      const topicDoc = await Topic.findOne({ _id: publicTopic._id })
      // Check that properties sent in request are updated
      expect(topicDoc!.name).toEqual('favorite dogs')
      expect(topicDoc!.slug).toEqual(slugify('favorite dogs'))
      expect(topicDoc!.archivable).toEqual(true)
      // Check that property that was not sent in request is not missing or updated
      expect(topicDoc!.votingAllowed).toBeDefined()
      expect(topicDoc!.votingAllowed).toEqual(publicTopic.votingAllowed)
      expect(topicDoc!.conversationCreationAllowed).toBeDefined()
      expect(topicDoc!.conversationCreationAllowed).toEqual(publicTopic.conversationCreationAllowed)
    })

    test('should return 400 if missing topic id', async () => {
      await insertUsers([registeredUser])
      const topicBody = { name: 'favorite dogs' }
      await request(app)
        .put(`/v1/topics/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(topicBody)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 if a private unallowed property is sent', async () => {
      await insertTopics([publicTopic])
      await insertUsers([registeredUser])
      await request(app)
        .put(`/v1/topics/`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({ id: publicTopic._id, name: 'favorite dogs', isArchiveNotified: true })
        .expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('POST /v1/topics/auth', () => {
    test('should return 200 if passcode is correct', async () => {
      await insertUsers([registeredUser])
      await insertTopics([privateTopic])
      await request(app)
        .post(`/v1/topics/auth`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          topicId: privateTopic._id,
          passcode: privateTopic.passcode
        })
        .expect(httpStatus.OK)
    })

    test('should return 401 if passcode is invalid', async () => {
      await insertUsers([registeredUser])
      await insertTopics([privateTopic])
      // Note: once in a blue moon, this could produce a false positive
      const badPasscode = getRandomInt(1000000, 9999999)
      await request(app)
        .post(`/v1/topics/auth`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({
          topicId: privateTopic._id,
          passcode: badPasscode
        })
        .expect(httpStatus.UNAUTHORIZED)
    })
  })

  describe('POST /v1/topics/archive', () => {
    let archiveToken
    beforeEach(async () => {
      await insertUsers([userOne])
      await insertTopics([publicTopic])
      userOne.id = userOne._id
      archiveToken = await tokenService.generateArchiveTopicToken(userOne)
    })

    test('should return 200 and archive topic', async () => {
      await request(app)
        .post(`/v1/topics/archive`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          topicId: publicTopic._id,
          token: archiveToken
        })
        .expect(httpStatus.OK)

      const dbTopic = await Topic.findById(publicTopic._id)
      expect(dbTopic!.archived).toBe(true)

      const dbTokenCount = await Token.countDocuments({ user: userOne._id, type: tokenTypes.ARCHIVE_TOPIC })
      expect(dbTokenCount).toBe(0)
    })

    test('should return 400 if missing a required field', async () => {
      await request(app)
        .post(`/v1/topics/archive`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          topicId: null,
          token: archiveToken
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 500 if token is invalid', async () => {
      await request(app)
        .post(`/v1/topics/archive`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          topicId: publicTopic._id,
          token: faker.datatype.uuid()
        })
        .expect(httpStatus.INTERNAL_SERVER_ERROR)
    })
  })

  describe('POST /v1/topics/userTopics', () => {
    test('should return 200 and body should be all topics for logged-in user', async () => {
      await insertUsers([userOne])
      await insertTopics([publicTopic, privateTopic])
      const resp = await request(app)
        .get(`/v1/topics/userTopics`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(2)
    })

    test('should return 200 and conversations should include followed', async () => {
      const newTopic = newPublicTopic()
      newTopic.owner = new mongoose.Types.ObjectId()
      await insertUsers([userOne])
      await insertTopics([publicTopic, privateTopic, newTopic])
      const topicFollow = {
        _id: new mongoose.Types.ObjectId(),
        user: userOne._id,
        topic: newTopic._id
      }
      await insertFollowers([topicFollow])
      const resp = await request(app)
        .get(`/v1/topics/userTopics`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(3)
    })

    test('should return 200 and include count of visible messages in conversations but not actual conversations', async () => {
      const newTopic = newPublicTopic()
      await insertUsers([userOne])
      privateTopic.conversations.push(conversationThree)
      await insertTopics([publicTopic, privateTopic, newTopic])
      await insertMessages([messageFour, invisibleMessage])

      conversationThree.messages = [messageFour, invisibleMessage]
      conversationThree.topic = privateTopic._id
      await insertConversations([conversationThree])

      const resp = await request(app)
        .get(`/v1/topics/userTopics`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(3)
      const pt = resp.body.find((x) => x.id === privateTopic._id.toString())
      expect(pt.messageCount).toEqual(1)
      expect(pt.conversations).toBeUndefined()
    })
  })
})
