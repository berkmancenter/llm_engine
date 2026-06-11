import httpStatus from 'http-status'
import request from 'supertest'
import crypto from 'crypto'
import qs from 'qs'
import app from '../../src/app.js'
import setupIntTest from '../utils/setupIntTest.js'
import config from '../../src/config/config.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Conversation from '../../src/models/conversation.model.js'
import { conversationAgentsEnabled, publicTopic } from '../fixtures/conversation.fixture.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import webhookService from '../../src/services/webhook.service.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import slackInteractionHandler from '../../src/handlers/slackInteraction.js'

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

    test('should return 401 if slack adapter not found for channel', async () => {
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

      // 401 (not 404): the middleware refuses to confirm whether the adapter is missing or
      // the signature is bad, so attackers can't enumerate which channels are wired up.
      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('should return 401 if slack adapter not found for workspace', async () => {
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
        .expect(httpStatus.UNAUTHORIZED)

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

    test('should process two messages with different event_ids', async () => {
      const makePayload = (eventId: string) => ({
        event_id: eventId,
        event: {
          type: 'message',
          text: 'Hello from Slack!',
          channel: 'C1234567890',
          team: '123456',
          user: 'U1234567890',
          ts: '1234567890.123456'
        }
      })

      const timestamp = Math.floor(Date.now() / 1000).toString()

      const payload1 = makePayload('Ev0FIRST1234')
      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', generateSlackSignature(timestamp, JSON.stringify(payload1)))
        .set('x-slack-request-timestamp', timestamp)
        .send(payload1)
        .expect(httpStatus.OK)

      const payload2 = makePayload('Ev0SECOND123')
      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', generateSlackSignature(timestamp, JSON.stringify(payload2)))
        .set('x-slack-request-timestamp', timestamp)
        .send(payload2)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledTimes(2)
    })

    test('should process messages with no event_id', async () => {
      const payload = {
        event: {
          type: 'message',
          text: 'Hello from Slack!',
          channel: 'C1234567890',
          team: '123456',
          user: 'U1234567890',
          ts: '1234567890.123456'
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

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledTimes(2)
    })

    test('should not process the same event_id twice', async () => {
      const payload = {
        event_id: 'Ev0TEST12345',
        event: {
          type: 'message',
          text: 'Hello from Slack!',
          channel: 'C1234567890',
          team: '123456',
          user: 'U1234567890',
          ts: '1234567890.123456'
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload))

      const sendRequest = () =>
        request(app)
          .post('/v1/webhooks/slack')
          .set('x-slack-signature', signature)
          .set('x-slack-request-timestamp', timestamp)
          .send(payload)

      await sendRequest().expect(httpStatus.OK)
      await sendRequest().expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledTimes(1)
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

  describe('Per-bot URL routing (:appKey)', () => {
    test('routes a request at /v1/webhooks/slack/:appKey to the adapter with that appKey', async () => {
      const mongoose = await import('mongoose')
      // VA-style second bot. Workspace + channel deliberately mismatch the incoming payload so the
      // ONLY way to resolve this adapter is via the :appKey URL segment.
      const vaConvo = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
      await vaConvo.save()
      const vaAdapter = await Adapter.create({
        type: 'slack',
        config: {
          // Same workspace as the payload (a single bot lives in one workspace), but a different
          // channel than the payload's. That makes the appKey URL segment the only way to resolve
          // this adapter — workspace+channel fallback would not match.
          channel: 'C_VA_NEVER_IN_PAYLOAD',
          workspace: 'T_VA_WORKSPACE',
          appKey: 'va',
          signingSecret: 'va-secret',
          botToken: 'xoxb-va',
          botUserId: 'U_VA'
        },
        conversation: vaConvo._id,
        active: true
      })

      const payload = {
        event: { type: 'message', text: 'hi VA', channel: 'C_OTHER', team: 'T_VA_WORKSPACE' }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload), 'va-secret')

      await request(app)
        .post('/v1/webhooks/slack/va')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: vaAdapter._id }), payload.event)
    })

    test('legacy /v1/webhooks/slack still works for the original bot with no appKey', async () => {
      const payload = {
        event: { type: 'message', text: 'hi Berkie', channel: 'C1234567890', team: '123456' }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload), 'test-signing-secret')

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: slackAdapter._id }), payload.event)
    })
  })

  describe('Per-adapter signing secret', () => {
    test('accepts a webhook signed with the adapter-specific secret', async () => {
      slackAdapter.config = { ...slackAdapter.config, signingSecret: 'per-adapter-secret' }
      slackAdapter.markModified('config')
      await slackAdapter.save()

      const payload = {
        event: { type: 'message', text: 'hi', channel: 'C1234567890', team: '123456' }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload), 'per-adapter-secret')

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalled()
    })

    test('rejects a webhook signed with the env secret when the adapter has its own secret', async () => {
      slackAdapter.config = { ...slackAdapter.config, signingSecret: 'per-adapter-secret' }
      slackAdapter.markModified('config')
      await slackAdapter.save()

      const payload = {
        event: { type: 'message', text: 'hi', channel: 'C1234567890', team: '123456' }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const wrongSignature = generateSlackSignature(timestamp, JSON.stringify(payload), 'test-signing-secret')

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', wrongSignature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })

    test('falls back to the env secret when the adapter has no signingSecret of its own', async () => {
      const payload = {
        event: { type: 'message', text: 'hi', channel: 'C1234567890', team: '123456' }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload), 'test-signing-secret')

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(receiveMessageSpy).toHaveBeenCalled()
    })

    test('rejects with 401 when no adapter matches the webhook payload', async () => {
      const payload = {
        event: { type: 'message', text: 'hi', channel: 'C_NONE', team: 'T_NONE' }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, JSON.stringify(payload), 'test-signing-secret')

      await request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)

      expect(receiveMessageSpy).not.toHaveBeenCalled()
    })
  })

  describe('Slack interactive component (block_actions) handling', () => {
    let receiveInteractionSpy

    // Builds a minimal block_actions payload and URL-encodes it as Slack would send it.
    function makeInteractionBody(overrides = {}) {
      const payload = {
        type: 'block_actions',
        team: { id: '123456' },
        channel: { id: 'C1234567890' },
        user: { id: 'U1234567890' },
        actions: [{ action_id: 'confirm', value: 'yes' }],
        message: { ts: '1234567890.123456' },
        ...overrides
      }
      return qs.stringify({ payload: JSON.stringify(payload) })
    }

    function signAndPost(rawBody: string) {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateSlackSignature(timestamp, rawBody)
      return request(app)
        .post('/v1/webhooks/slack')
        .set('x-slack-signature', signature)
        .set('x-slack-request-timestamp', timestamp)
        .set('content-type', 'application/x-www-form-urlencoded')
        .send(rawBody)
    }

    beforeEach(() => {
      receiveInteractionSpy = jest.spyOn(slackInteractionHandler, 'receiveInteraction').mockResolvedValue()
    })

    test('routes a button-click (block_actions) payload to the interaction handler', async () => {
      await signAndPost(makeInteractionBody()).expect(httpStatus.OK)

      expect(receiveInteractionSpy).toHaveBeenCalledTimes(1)
      expect(receiveInteractionSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'block_actions' }))
    })

    test('acknowledges unknown interaction types with 200 without routing them', async () => {
      const body = qs.stringify({ payload: JSON.stringify({ type: 'shortcut', callback_id: 'my_shortcut' }) })
      await signAndPost(body).expect(httpStatus.OK)

      expect(receiveInteractionSpy).not.toHaveBeenCalled()
    })

    test('acknowledges malformed JSON payload gracefully with 200 — prevents Slack retries', async () => {
      const body = qs.stringify({ payload: 'this is not valid JSON {{{' })
      await signAndPost(body).expect(httpStatus.OK)

      expect(receiveInteractionSpy).not.toHaveBeenCalled()
    })

    test('still processes normal Slack message events (JSON body, no payload field) unchanged', async () => {
      const messageEvent = {
        type: 'message',
        text: 'Hello!',
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
      expect(receiveInteractionSpy).not.toHaveBeenCalled()
    })
  })
})
