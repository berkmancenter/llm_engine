// FYI, mongoose does not work well with jest.useFakeTimers()
// so we avoid it
// ref: https://mongoosejs.com/docs/5.x/docs/jest.html

import mongoose from 'mongoose'
import request from 'supertest'
import httpStatus from 'http-status'
import app from '../../../src/app.js'
import { insertUsers, userOne, userTwo, admin } from '../../fixtures/user.fixture.js'
import { userOneAccessToken, userTwoAccessToken, adminAccessToken } from '../../fixtures/token.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import { pollOneBody, privateTopic, getPollChoices } from '../../fixtures/poll.fixture.js'
import config from '../../../src/config/config.js'
import sleep from '../../../src/utils/sleep.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'

// allow more time
jest.setTimeout(10000)

const BASE_API = '/v1/polls'
const EXPIRATION_MS = 2000

const CHOICE1_TEXT = 'Choice 1'
const CHOICE2_TEXT = 'Choice 2'

describe(`Poll API - Variant 1: ${pollOneBody.title}`, () => {
  // we keep our database between tests and perform a sequence of tests that should be evaluated in order
  beforeAll(async () => {
    await mongoose.connect(config.mongoose.url, config.mongoose.options)
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
    await insertUsers([userOne, userTwo, admin])
    await insertTopics([privateTopic])
  })

  afterAll(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})))
    await mongoose.disconnect()
  })

  let topicId
  let pollId
  let pollData
  let user1PollResponse1
  let adminPollResponse2

  // now
  const startDate = new Date()
  // expirationDate is 5 seconds after now
  const expirationDate = new Date(startDate.getTime())
  expirationDate.setSeconds(expirationDate.getSeconds() + Math.floor(EXPIRATION_MS / 1000))

  test('Create a poll', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = { ...pollOneBody }
    body.expirationDate = expirationDate.toISOString()
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

    expect(resp.body).toMatchObject(pollData)
    expect(resp.body.topic.id).toMatch(pollOneBody.topicId)
    expect(resp.body.owner).toMatch(userOne._id.toString())
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

    user1PollResponse1 = expectedResp

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('User 1 responds to poll choice 1 again', async () => {
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

    const expectedResp = user1PollResponse1

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('User 1 inspects poll', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toMatchObject(pollData)
    expect(resp.body.choices).toBe(undefined)
  })

  test('User 1 checks responses before poll is closed', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('Expiration date has not been reached')).toBe(true)
  })

  test('Admin responds to poll choice 2', async () => {
    const body = {
      choice: {
        text: CHOICE2_TEXT
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
    const pollChoice = pollChoices.find((c) => c.text === CHOICE2_TEXT)

    const expectedResp = {
      poll: pollId,
      choice: pollChoice!._id.toString(),
      owner: admin._id.toString()
    }

    adminPollResponse2 = expectedResp

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('Admin removes response to poll choice 2', async () => {
    const body = {
      choice: {
        text: CHOICE2_TEXT,
        remove: true
      },
      topicId
    }
    jest.spyOn(websocketGateway, 'broadcastNewPollChoice').mockResolvedValue()
    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(body)
      .expect(httpStatus.OK)

    const expectedResp = { ...adminPollResponse2, removed: true }
    expect(resp.body).toMatchObject(expectedResp)
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

  test('User 1 responds to poll choice 2', async () => {
    const body = {
      choice: {
        text: CHOICE2_TEXT
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
    const pollChoice = pollChoices.find((c) => c.text === CHOICE2_TEXT)

    const expectedResp = {
      poll: pollId,
      choice: pollChoice!._id.toString(),
      owner: userOne._id.toString()
    }

    expect(resp.body).toMatchObject(expectedResp)
  })

  test('User 1 checks responses after poll is closed', async () => {
    await sleep(EXPIRATION_MS)
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userOneAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toHaveLength(3)
    expect(resp.body[0].owner).toBe(userOne.username)
    expect(resp.body[0].choice).toBe(CHOICE1_TEXT)
    expect(resp.body[1].owner).toBe(userTwo.username)
    expect(resp.body[1].choice).toBe(CHOICE2_TEXT)
    expect(resp.body[2].owner).toBe(userOne.username)
    expect(resp.body[2].choice).toBe(CHOICE2_TEXT)
  })

  test('User 2 checks responses after poll is closed', async () => {
    const resp = await request(app)
      .get(`${BASE_API}/${pollId}/responses`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .expect(httpStatus.OK)

    expect(resp.body).toHaveLength(2)
    expect(resp.body[0].owner).toBe(userTwo.username)
    expect(resp.body[0].choice).toBe(CHOICE2_TEXT)
    expect(resp.body[1].owner).toBe(userOne.username)
    expect(resp.body[1].choice).toBe(CHOICE2_TEXT)
  })

  test('User 2 responds to poll after it is closed', async () => {
    const body = {
      choice: {
        text: CHOICE1_TEXT
      },
      topicId
    }

    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .send(body)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('Expiration date has been reached. No more responses are allowed.')).toBe(true)
  })

  test('User 1 tries to remove response to poll after it is closed', async () => {
    const body = {
      choice: {
        text: CHOICE1_TEXT,
        remove: true
      },
      topicId
    }

    const resp = await request(app)
      .post(`${BASE_API}/${pollId}/respond`)
      .set('Authorization', `Bearer ${userTwoAccessToken}`)
      .send(body)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('Expiration date has been reached. No more responses are allowed.')).toBe(true)
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
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(httpStatus.FORBIDDEN)

    expect(resp.body.message.includes('You have not participated in this poll')).toBe(true)
  })
})
