import httpStatus from 'http-status'
import request from 'supertest'
import crypto from 'crypto'
import { Buffer } from 'buffer'
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

// Helper function to generate valid webhook signatures for testing
const generateWebhookSignature = (payload: object, secret: string) => {
  const msgId = `msg_${Date.now()}`
  const msgTimestamp = Math.floor(Date.now() / 1000).toString()
  const payloadStr = JSON.stringify(payload)

  const prefix = 'whsec_'
  const base64Part = secret.startsWith(prefix) ? secret.slice(prefix.length) : secret
  const key = Buffer.from(base64Part, 'base64')

  const toSign = `${msgId}.${msgTimestamp}.${payloadStr}`
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('base64')

  return {
    'webhook-id': msgId,
    'webhook-timestamp': msgTimestamp,
    'webhook-signature': `v1,${signature}`
  }
}

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
  let realtimeSecret
  let svixSecret
  let conversation
  beforeAll(() => {
    setAdapterTypes(testAdapterTypes)
    realtimeSecret = config.recall.realtimeSecret
    svixSecret = config.recall.svixSecret
    // Set fake secrets for testing (base64 encoded strings after whsec_ prefix)
    config.recall.realtimeSecret = `whsec_${Buffer.from('test-realtime-secret-key').toString('base64')}`
    config.recall.svixSecret = `whsec_${Buffer.from('test-svix-secret-key').toString('base64')}`
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
    config.recall.realtimeSecret = realtimeSecret
    config.recall.svixSecret = svixSecret
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })
  test('should return 200 and route to the correct zoom adapter when properly authenticated', async () => {
    const testEvent = { event: 'transcript.data', data: { text: 'Welcome to our meeting', bot: { id: botId } } }
    const headers = generateWebhookSignature(testEvent, config.recall.realtimeSecret)
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=${conversation._id}`)
      .set(headers)
      .send(testEvent)
      .expect(httpStatus.OK)
    expect(receiveMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: zoomAdapter._id }), testEvent)
  })
  test('should return 401 when webhook signature verification fails', async () => {
    const testEvent = { event: 'transcript.data', data: { text: 'Welcome to our meeting', bot: { id: botId } } }
    // Send request without valid signature headers
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=${conversation._id}`)
      .send(testEvent)
      .expect(httpStatus.UNAUTHORIZED)
  })
  test('should return 200 and do nothing if unsupported event type', async () => {
    const testEvent = { event: 'something', data: { text: 'Welcome to our meeting' } }
    const headers = generateWebhookSignature(testEvent, config.recall.realtimeSecret)
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=${conversation._id}`)
      .set(headers)
      .send(testEvent)
      .expect(httpStatus.OK)
  })
  test('should return 404 if conversation not found', async () => {
    const testEvent = { event: 'transcript.data', data: { text: 'Welcome to our meeting', bot: { id: botId } } }
    const headers = generateWebhookSignature(testEvent, config.recall.realtimeSecret)
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=68250298445b876b3451add4`)
      .set(headers)
      .send(testEvent)
      .expect(httpStatus.NOT_FOUND)
  })
  test('should return 404 if zoom type adapter not found', async () => {
    const noAdapterconversation = new Conversation({
      name: 'Plastic Water Bottles',
      owner: registeredUser._id,
      topic: publicTopic._id
    })
    await noAdapterconversation.save()
    const testEvent = { event: 'transcript.data', data: { text: 'Welcome to our meeting', bot: { id: botId } } }
    const headers = generateWebhookSignature(testEvent, config.recall.realtimeSecret)
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=${noAdapterconversation._id}`)
      .set(headers)
      .send(testEvent)
      .expect(httpStatus.NOT_FOUND)
  })
  test('should return 404 if zoom adapter with specific botId not found', async () => {
    const differentBotId = 'different-bot-id'
    const testEvent = { event: 'transcript.data', data: { text: 'Welcome to our meeting', bot: { id: differentBotId } } }
    const headers = generateWebhookSignature(testEvent, config.recall.realtimeSecret)
    await request(app)
      .post(`/v1/webhooks/recall?conversationId=${conversation._id}`)
      .set(headers)
      .send(testEvent)
      .expect(httpStatus.NOT_FOUND)

    expect(receiveMessageSpy).not.toHaveBeenCalled()
  })

  describe('bot.call_ended event', () => {
    test('should trigger redeploy when bot times out in waiting room', async () => {
      // Set conversation as active so bot redeploy is triggered
      conversation.active = true
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'timeout_exceeded_waiting_room',
            message: 'Bot timed out in waiting room'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy when no one joined yet', async () => {
      // Set conversation as active so bot redeploy is triggered
      conversation.active = true
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'timeout_exceeded_noone_joined',
            message: 'No one joined the meeting'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy on bot_received_leave_call', async () => {
      // Set conversation as active so bot redeploy is triggered
      conversation.active = true
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'bot_received_leave_call',
            message: 'Bot received leave call request'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should not redeploy when host ends call', async () => {
      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'call_ended_by_host',
            message: 'Host ended the call'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should not redeploy when bot is kicked', async () => {
      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'bot_kicked_from_call',
            message: 'Bot was removed by host'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(mockZoomStart).not.toHaveBeenCalled()
    })
  })
})
