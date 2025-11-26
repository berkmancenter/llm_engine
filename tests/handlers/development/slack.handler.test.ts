import httpStatus from 'http-status'
import request from 'supertest'
import crypto from 'crypto'
import app from '../../../src/app.js'
import setupIntTest from '../../utils/setupIntTest.js'
import config from '../../../src/config/config.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import Conversation from '../../../src/models/conversation.model.js'
import { conversationAgentsEnabled, publicTopic } from '../../fixtures/conversation.fixture.js'
import Adapter, { setAdapterTypes } from '../../../src/models/adapter.model.js'
import webhookService from '../../../src/services/webhook.service.js'
import defaultAdapterTypes from '../../../src/adapters/index.js'

setupIntTest()

let conversation
let slackSigningSecret
let receiveMessageSpy
let slackAdapter

const mockSlackStart = jest.fn()
const mockSlackStop = jest.fn()
const mockSlackGetUniqueKeys = jest.fn()

const testAdapterTypes = {
  slack: {
    start: mockSlackStart,
    stop: mockSlackStop,
    getUniqueKeys: mockSlackGetUniqueKeys
  }
}

// Helper function to generate valid Slack signature
const generateSlackSignature = (timestamp: string, body: string, secret: string = 'test-signing-secret'): string => {
  const baseString = `v0:${timestamp}:${body}`
  const signature = crypto.createHmac('sha256', secret).update(baseString, 'utf8').digest('hex')
  return `v0=${signature}`
}

describe('POST /v1/webhooks/slack', () => {
  beforeAll(() => {
    setAdapterTypes(testAdapterTypes)

    slackSigningSecret = config.slack.signingSecret

    config.slack.signingSecret = 'test-signing-secret'
  })
  beforeEach(async () => {
    await insertTopics([publicTopic])
    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()

    slackAdapter = await Adapter.create({
      type: 'slack',
      config: { channel: 'C1234567890', workspace: '123456' },
      conversation: conversation._id,
      active: true
    })
    conversation.adapters.push(slackAdapter)
    await conversation.save()
    receiveMessageSpy = jest.spyOn(webhookService, 'receiveMessage').mockResolvedValue()
    mockSlackGetUniqueKeys.mockReturnValue(['type', 'config.channel', 'config.workspace'])
  })
  afterAll(() => {
    setAdapterTypes(defaultAdapterTypes)
    config.slack.signingSecret = slackSigningSecret
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })

  describe('URL verification', () => {
    test('should return challenge for URL verification', async () => {
      const challenge = 'test-challenge-string'
      const payload = { type: 'url_verification', challenge }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      const response = await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(response.text).toBe(challenge)
    })
  })

  describe('Signature validation', () => {
    test('should accept valid signature', async () => {
      const payload = {
        event: {
          type: 'message',
          text: 'Hello world',
          channel: 'C1234567890',
          team: '123456'
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: slackAdapter._id }), payload.event)
    })

    test('should reject invalid signature', async () => {
      const payload = {
        event: {
          type: 'message',
          text: 'Hello world',
          channel: 'C1234567890',
          team: '123456'
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const invalidSignature = 'v0=invalid-signature'

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', invalidSignature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should reject missing signature', async () => {
      const payload = {
        event: {
          type: 'message',
          text: 'Hello world',
          channel: 'C1234567890',
          team: '123456'
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should reject old timestamp (replay attack prevention)', async () => {
      const payload = {
        event: {
          type: 'message',
          text: 'Hello world',
          channel: 'C1234567890',
          team: '123456'
        }
      }
      // Timestamp from 10 minutes ago (older than 5-minute window)
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString()
      const signature = generateSlackSignature(oldTimestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', oldTimestamp)
        .send(payload)
        .expect(httpStatus.BAD_REQUEST)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should reject missing timestamp', async () => {
      const payload = {
        event: {
          type: 'message',
          text: 'Hello world',
          channel: 'C1234567890',
          team: '123456'
        }
      }
      const signature = 'v0=some-signature'

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .send(payload)
        .expect(httpStatus.BAD_REQUEST)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })
  })

  describe('Message handling', () => {
    test('should process valid message event', async () => {
      const messageEvent = {
        type: 'message',
        text: 'Hello from Slack!',
        channel: 'C1234567890',
        team: '123456',
        user: 'U1234567890',
        ts: '1234567890.123456'
      }
      const payload = { event: messageEvent }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: slackAdapter._id }), messageEvent)
    })

    test('should skip bot messages', async () => {
      const botMessageEvent = {
        type: 'message',
        text: 'Hello from bot!',
        channel: 'C1234567890',
        team: '123456',
        bot_id: 'B1234567890',
        ts: '1234567890.123456'
      }
      const payload = { event: botMessageEvent }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should skip messages with subtypes', async () => {
      const subtypeMessageEvent = {
        type: 'message',
        text: 'Message edited',
        channel: 'C1234567890',
        team: '123456',
        subtype: 'message_changed',
        ts: '1234567890.123456'
      }
      const payload = { event: subtypeMessageEvent }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should return 404 if slack adapter not found for channel', async () => {
      const messageEvent = {
        type: 'message',
        text: 'Hello from unknown channel!',
        channel: 'C9999999999', // Different channel
        team: '123456',
        user: 'U1234567890',
        ts: '1234567890.123456'
      }
      const payload = { event: messageEvent }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.NOT_FOUND)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should return 404 if slack adapter not found for workspace', async () => {
      const messageEvent = {
        type: 'message',
        text: 'Hello!',
        channel: 'C1234567890',
        team: '123456789', // Different workspace
        user: 'U1234567890',
        ts: '1234567890.123456'
      }
      const payload = { event: messageEvent }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.NOT_FOUND)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should ignore non-message events', async () => {
      const nonMessageEvent = {
        type: 'app_mention',
        text: 'Hey <@U123456789>!',
        channel: 'C1234567890',
        team: '123456',
        user: 'U1234567890',
        ts: '1234567890.123456'
      }
      const payload = { event: nonMessageEvent }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should handle payload without event', async () => {
      const payload = { type: 'event_callback' } // Missing event property
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })
  })
})
