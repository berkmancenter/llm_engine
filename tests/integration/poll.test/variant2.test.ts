import mongoose from 'mongoose'
import request from 'supertest'
import httpStatus from 'http-status'
import app from '../../../src/app.js'
import { insertUsers, userOne, userTwo, admin, registeredUser } from '../../fixtures/user.fixture.js'
import {
  userOneAccessToken,
  userTwoAccessToken,
  adminAccessToken,
  registeredUserAccessToken
} from '../../fixtures/token.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { pollTwoBody, privateTopic, getPollChoices } from '../../fixtures/poll.fixture.js'
import config from '../../../src/config/config.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'

// allow more time
jest.setTimeout(10000)

const BASE_API = '/v1/polls'

const CHOICE1_TEXT = 'Choice 1'
const CHOICE2_TEXT = 'Choice 2'

describe(`Poll API - Variant 2: ${pollTwoBody.title}`, () => {
  // we keep our database between tests and perform a sequence of tests that should be evaluated in order
  beforeAll(async () => {
    await mongoose.connect(config.mongoose.url, config.mongoose.options)
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
    await insertUsers([userOne, userTwo, admin, registeredUser])
    await insertTopics([privateTopic])
  })

  afterAll(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
    await mongoose.disconnect()
  })

  let topicId
  let pollId
  let pollData

  test('Create a poll', async () => {
    const body = { ...pollTwoBody }
    jest.spyOn(websocketGateway, 'broadcastNewPoll').mockResolvedValue()
    const resp = await request(app)
      .post(BASE_API)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(body)
      .expect(httpStatus.CREATED)

    // used in other tests
    pollId = resp.body.id

    pollData = { ...body }
    topicId = pollData.topicId
    delete pollData.topicId
    delete pollData.owner
    delete pollData.choices

    expect(resp.body).toMatchObject(pollData)
    expect(resp.body.topic.id).toMatch(pollTwoBody.topicId)
    expect(resp.body.owner).toMatch(userOne._id.toString())
  })

  test('User 1 responds to poll with unavailable choice', async () => {
    const body = {
      choice: {
        text: 'NEW CHOICE NOT ALREADY AVAILABLE'
      },
      topicId
    }

    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(body)
      .expect(httpStatus.BAD_REQUEST)

    expect(resp.body.message.includes('Only existing poll choices are allowed')).toBe(true)
  })

  test('User 1 checks responses before participating', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('You have not participated in this poll')).toBe(true)
  })

  test('User 1 responds to poll choice 1', async () => {
    const body = {
      choice: {
        text: CHOICE1_TEXT
      },
      topicId
    }
    jest.spyOn(websocketGateway, 'broadcastNewPollChoice').mockResolvedValue()
    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(body)
      .expect(httpStatus.OK)

    const pollChoices = await getPollChoices(pollId)
    const pollChoice1 = pollChoices.find((c) => c.text === CHOICE1_TEXT)

    const expectedResp = {
      poll: pollId,
      choice: pollChoice1!._id.toString(),
      owner: userOne._id.toString()
    }

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('User 1 inspects poll', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toMatchObject(pollData)
    expect(resp.body.choices).toHaveLength(3)
    expect(resp.body.choices[0].text).toBe(CHOICE1_TEXT)
    expect(resp.body.choices[1].text).toBe(CHOICE2_TEXT)
  })

  test('User 2 responds to poll choice 2', async () => {
    const body = {
      choice: {
        text: CHOICE2_TEXT
      },
      topicId
    }
    jest.spyOn(websocketGateway, 'broadcastNewPollChoice').mockResolvedValue()
    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .send(body)
      .expect(httpStatus.OK)

    const pollChoices = await getPollChoices(pollId)
    const pollChoice = pollChoices.find((c) => c.text === CHOICE2_TEXT)

    const expectedResp = {
      poll: pollId,
      choice: pollChoice!._id.toString(),
      owner: userTwo._id.toString()
    }

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('User 2 checks responses before threshold has been reached', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('Threshold has not been reached')).toBe(true)
  })

  test('User 1 responds to poll choice 2', async () => {
    const body = {
      choice: {
        text: CHOICE2_TEXT
      },
      topicId
    }

    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .send(body)
      .expect(httpStatus.BAD_REQUEST)

    expect(resp.body.message.includes('Only one response is allowed for this poll')).toBe(true)
  })

  test('Admin responds to poll choice 1', async () => {
    const body = {
      choice: {
        text: CHOICE1_TEXT
      },
      topicId
    }
    jest.spyOn(websocketGateway, 'broadcastNewPollChoice').mockResolvedValue()
    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(body)
      .expect(httpStatus.OK)

    const pollChoices = await getPollChoices(pollId)
    const pollChoice = pollChoices.find((c) => c.text === CHOICE1_TEXT)

    const expectedResp = {
      poll: pollId,
      choice: pollChoice!._id.toString(),
      owner: admin._id.toString()
    }

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('User 1 checks responses after poll threshold is reached', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toHaveLength(2)
    expect(resp.body[0].owner).toBe(userOne.username)
    expect(resp.body[0].choice).toBe(CHOICE1_TEXT)
    expect(resp.body[1].owner).toBe(admin.username)
    expect(resp.body[1].choice).toBe(CHOICE1_TEXT)
  })

  test('User 2 checks responses after threshold is reached', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toHaveLength(2)
    expect(resp.body[0].owner).toBe(userOne.username)
    expect(resp.body[0].choice).toBe(CHOICE1_TEXT)
    expect(resp.body[1].owner).toBe(admin.username)
    expect(resp.body[1].choice).toBe(CHOICE1_TEXT)
  })

  test('User 2 inspects poll', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toMatchObject(pollData)
  })

  test('User 1 checks response counts after poll is closed', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responseCounts`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('Response counts are not visible for this poll')).toBe(true)
  })

  test('Non-participating user checks responses after poll is closed', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${registeredUserAccessToken}`)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('You have not participated in this poll')).toBe(true)
  })
})
