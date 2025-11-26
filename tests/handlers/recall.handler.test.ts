import httpStatus from 'http-status'
import request from 'supertest'
import app from '../../src/app.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import { conversationAgentsEnabled, publicTopic } from '../fixtures/conversation.fixture.js'
import Conversation from '../../src/models/conversation.model.js'
import config from '../../src/config/config.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import webhookService from '../../src/services/webhook.service.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import setupIntTest from '../utils/setupIntTest.js'
import { registeredUser } from '../fixtures/user.fixture.js'

setupIntTest()

const mockZoomStart = jest.fn()
const mockZoomStop = jest.fn()
const mockZoomGetUniqueKeys = jest.fn()

const botId = 'test-bot-id'

const meetingId = 'test-meeting-123'

const testAdapterTypes = {
  zoom: {
    start: mockZoomStart,
    stop: mockZoomStop,
    getUniqueKeys: mockZoomGetUniqueKeys
  }
}

describe('POST /v1/webhooks/recall', () => {
  let receiveMessageSpy
  let zoomAdapter
  let recallToken
  let conversation
  beforeAll(() => {
    setAdapterTypes(testAdapterTypes)
    recallToken = config.recall.token
    // This token can be any string, set for internal testing so env variable not required
    config.recall.token = 'dlakdfj000223dkflsdkjx232'
  })
  beforeEach(async () => {
    await insertTopics([publicTopic])
    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()
    zoomAdapter = await Adapter.create({
      type: 'zoom',
      config: { botId, meetingUrl: `https://zoom.us/j/${meetingId}` },
      conversation: conversation._id,
      active: true
    })
    conversation.adapters.push(zoomAdapter)
    await conversation.save()
    receiveMessageSpy = jest.spyOn(webhookService, 'receiveMessage').mockResolvedValue()
    mockZoomGetUniqueKeys.mockReturnValue(['type', 'config.meetingUrl'])
  })
  afterAll(() => {
    setAdapterTypes(defaultAdapterTypes)
    config.recall.token = recallToken
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })
  test('should return 200 and route to the correct zoom adapter when properly authenticated', async () => {
    const testEvent = { event: 'transcript.data', data: { text: 'Welcome to our meeting', bot: { id: botId } } }
    await request(app)
      .post(`/v1/webhooks/recall?token=${config.recall.token}&conversationId=${conversation._id}`)
      .send(testEvent)
      .expect(httpStatus.OK)
    expect(receiveMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: zoomAdapter._id }), testEvent)
  })
  test('should return 401 if token invalid', async () => {
    const testData = { text: 'Welcome to our meeting' }
    await request(app)
      .post(`/v1/webhooks/recall?token=foo&conversationId=${conversation._id}`)
      .send({ event: 'transcript.data', data: testData })
      .expect(httpStatus.UNAUTHORIZED)
  })
  test('should return 401 if token missing', async () => {
    const testData = { text: 'Welcome to our meeting' }
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=${conversation._id}`)
      .send({ event: 'transcript.data', data: testData })
      .expect(httpStatus.UNAUTHORIZED)
  })
  test('should return 200 and do nothing if unsupported event type', async () => {
    const testData = { text: 'Welcome to our meeting' }
    await request(app)
      .post(`/v1/webhooks/recall?token=${config.recall.token}&conversationId=${conversation._id}`)
      .send({ event: 'something', data: testData })
      .expect(httpStatus.OK)
  })
  test('should return 404 if conversation not found', async () => {
    const testData = { text: 'Welcome to our meeting' }
    await request(app)
      .post(`/v1/webhooks/recall?token=${config.recall.token}&conversationId=68250298445b876b3451add4`)
      .send({ event: 'transcript.data', data: testData })
      .expect(httpStatus.NOT_FOUND)
  })
  test('should return 404 if zoom type adapter not found', async () => {
    const noAdapterconversation = new Conversation({
      name: 'Plastic Water Bottles',
      owner: registeredUser._id,
      topic: publicTopic._id
    })
    await noAdapterconversation.save()
    const testData = { text: 'Welcome to our meeting', bot: { id: botId } }
    await request(app)
      .post(`/v1/webhooks/recall?token=${config.recall.token}&conversationId=${noAdapterconversation._id}`)
      .send({ event: 'transcript.data', data: testData })
      .expect(httpStatus.NOT_FOUND)
  })
  test('should return 404 if zoom adapter with specific botId not found', async () => {
    const differentBotId = 'different-bot-id'
    const testData = { text: 'Welcome to our meeting', bot: { id: differentBotId } }
    await request(app)
      .post(`/v1/webhooks/recall?token=${config.recall.token}&conversationId=${conversation._id}`)
      .send({ event: 'transcript.data', data: testData })
      .expect(httpStatus.NOT_FOUND)

    expect(receiveMessageSpy).not.toHaveBeenCalled()
  })
})
