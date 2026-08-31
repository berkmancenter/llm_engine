import mongoose from 'mongoose'
import request from 'supertest'
import httpStatus from 'http-status'
import app from '../../../src/app.js'
import { insertUsers, userOne, userTwo } from '../../fixtures/user.fixture.js'
import { userOneAccessToken, userTwoAccessToken } from '../../fixtures/token.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { conversationOne, insertConversations, publicTopic } from '../../fixtures/conversation.fixture.js'
import { pollFourBody } from '../../fixtures/poll.fixture.js'
import config from '../../../src/config/config.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import schedule from '../../../src/jobs/schedule.js'
import Conversation from '../../../src/models/conversation.model.js'

const BASE_API = '/v1/polls'

const CHOICE1_TEXT = 'Choice 1'
const CHOICE2_TEXT = 'Choice 2'

describe(`Poll API - Variant 4: ${pollFourBody.title}`, () => {
  beforeAll(async () => {
    await mongoose.connect(config.mongoose.url, config.mongoose.options)
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
    await insertUsers([userOne, userTwo])
    await insertTopics([publicTopic])
    await insertConversations([conversationOne])
  })

  afterAll(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
    await mongoose.disconnect()
  })

  let pollId

  test('Create a poll', async () => {
    jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue()
    jest.spyOn(schedule, 'pollExpired').mockResolvedValue()
    const resp = await request(app)
      .post(BASE_API)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(pollFourBody)
      .expect(httpStatus.CREATED)

    pollId = resp.body.id
    expect(resp.body.whenResultsVisible).toBe('always')
  })

  test('User 1 votes — choice:new broadcast includes pollId and counts', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastNewPollChoice').mockResolvedValue()

    await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ choice: { text: CHOICE1_TEXT } })
      .expect(httpStatus.OK)

    expect(broadcastSpy).toHaveBeenCalledTimes(1)
    const payload = broadcastSpy.mock.calls[0][1]
    expect(payload.pollId).toBe(pollId)
    expect(payload.counts).toBeDefined()
    expect(payload.counts[CHOICE1_TEXT]).toBe(1)
    expect(payload.counts[CHOICE2_TEXT]).toBe(0)
  })

  test('User 2 votes — counts reflect both votes', async () => {
    const broadcastSpy = jest.spyOn(websocketGateway, 'broadcastNewPollChoice').mockResolvedValue()
    broadcastSpy.mockClear()

    await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .send({ choice: { text: CHOICE2_TEXT } })
      .expect(httpStatus.OK)

    const payload = broadcastSpy.mock.calls[0][1]
    expect(payload.counts[CHOICE1_TEXT]).toBe(1)
    expect(payload.counts[CHOICE2_TEXT]).toBe(1)
  })

  test('Response counts endpoint returns correct counts', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responseCounts`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body[CHOICE1_TEXT]).toBe(1)
    expect(resp.body[CHOICE2_TEXT]).toBe(1)
  })

  test('Voting is rejected after conversation is deactivated', async () => {
    await Conversation.findByIdAndUpdate(conversationOne._id, { active: false })

    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send({ choice: { text: CHOICE2_TEXT } })
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message).toBe('This event has ended. Voting is no longer allowed.')
  })
})
