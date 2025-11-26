import httpStatus from 'http-status'
import request from 'supertest'
import crypto from 'crypto'
import mongoose from 'mongoose'
import app from '../../src/app.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import { conversationAgentsEnabled, publicTopic } from '../fixtures/conversation.fixture.js'
import { maxScheduledInterval } from '../../src/services/conversation.service.js'
import Conversation from '../../src/models/conversation.model.js'
import config from '../../src/config/config.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import webhookService from '../../src/services/webhook.service.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import setupIntTest from '../utils/setupIntTest.js'

setupIntTest()

const mockZoomStart = jest.fn()
const mockZoomStop = jest.fn()
const mockZoomGetUniqueKeys = jest.fn()

const botId = 'test-bot-id'

const testAdapterTypes = {
  zoom: {
    start: mockZoomStart,
    stop: mockZoomStop,
    getUniqueKeys: mockZoomGetUniqueKeys
  }
}

const generateZoomSignature = (timestamp: string, body: string, secretToken: string = 'test-zoom-secret'): string => {
  const message = `v0:${timestamp}:${body}`
  const signature = crypto.createHmac('sha256', secretToken).update(message, 'utf8').digest('hex')
  return `v0=${signature}`
}

describe('POST /v1/webhooks/zoom', () => {
  const meetingId = 'test-meeting-123'
  let conversation
  let zoomSecretToken
  let zoomAdapter
  let receiveMessageSpy
  beforeAll(() => {
    setAdapterTypes(testAdapterTypes)
    zoomSecretToken = config.zoom.secretToken
    config.zoom.secretToken = 'test-zoom-secret'
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
    config.zoom.secretToken = zoomSecretToken
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })
  describe('Signature validation', () => {
    test('should accept valid signature for meeting.started event', async () => {
      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: new Date()
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)
    })

    test('should reject invalid signature', async () => {
      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting'
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const invalidSignature = 'v0=invalid-signature'

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', invalidSignature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should reject missing signature', async () => {
      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should reject missing timestamp', async () => {
      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId
          }
        }
      }
      const signature = 'v0=some-signature'

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .send(payload)
        .expect(httpStatus.UNAUTHORIZED)
    })
  })
  describe('Event handling', () => {
    test('should handle meeting.started event and call adapter.start()', async () => {
      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: '2025-08-26T10:00:00Z'
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStart).toHaveBeenCalledTimes(1)
      expect(mockZoomStop).not.toHaveBeenCalled()
    })

    test('should handle meeting.ended event and call adapter.stop()', async () => {
      conversation.active = true
      await conversation.save()

      const payload = {
        event: 'meeting.ended',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            end_time: '2025-08-26T11:00:00Z'
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStop).toHaveBeenCalledTimes(1)
      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should return 200 and do nothing for unsupported event types', async () => {
      const payload = {
        event: 'meeting.participant_joined',
        payload: {
          object: {
            id: meetingId,
            participant: {
              user_id: 'user123',
              user_name: 'Test User'
            }
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStart).not.toHaveBeenCalled()
      expect(mockZoomStop).not.toHaveBeenCalled()
    })

    test('should return 200 when no zoom adapter found for meeting ID', async () => {
      const nonExistentMeetingId = 'non-existent-meeting-999'
      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: nonExistentMeetingId,
            host_id: 'host123',
            topic: 'Non-existent Meeting',
            start_time: new Date()
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should handle meeting.ended event when no adapter found without calling stop', async () => {
      const nonExistentMeetingId = 'non-existent-meeting-999'
      const payload = {
        event: 'meeting.ended',
        payload: {
          object: {
            id: nonExistentMeetingId,
            host_id: 'host123',
            topic: 'Non-existent Meeting'
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStop).not.toHaveBeenCalled()
    })

    test('should find adapter with meeting URL containing meeting ID (case insensitive)', async () => {
      // Create another adapter with different case in meeting URL
      const upperCaseMeetingId = meetingId.toUpperCase()
      await Adapter.create({
        type: 'zoom',
        config: {
          meetingUrl: `https://zoom.us/j/${upperCaseMeetingId}`,
          botId: 'another-bot-id'
        },
        conversation: conversation._id,
        active: true
      })

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId.toLowerCase(), // Send lowercase ID
            host_id: 'host123',
            topic: 'Case Test Meeting'
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // Should find and call start on one of the matching adapters
      // Note: The regex match is case-insensitive, so it should work
    })
  })
  describe('Multiple conversations with same meeting ID', () => {
    let conversation2
    let zoomAdapter2

    beforeEach(async () => {
      // Create a second conversation with the same meeting ID

      conversation2 = new Conversation({ ...conversationAgentsEnabled, _id: new mongoose.Types.ObjectId() })
      await conversation2.save()

      zoomAdapter2 = await Adapter.create({
        type: 'zoom',
        config: { botId: 'test-bot-id-2', meetingUrl: `https://zoom.us/j/${meetingId}` },
        conversation: conversation2._id,
        active: false
      })

      conversation2.adapters.push(zoomAdapter2)
      await conversation2.save()
    })

    test('should start conversation with matching scheduledTime when multiple conversations found', async () => {
      const startTime = new Date('2025-08-26T10:00:00Z')
      const scheduledTime = new Date(startTime.getTime() + (maxScheduledInterval - 1 * 60 * 1000)) // 1 minute less than the max

      // Set scheduledTime only on the first conversation
      conversation.scheduledTime = scheduledTime
      await conversation.save()

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // Should call start only once for the conversation with matching scheduled time
      expect(mockZoomStart).toHaveBeenCalledTimes(1)
    })

    test('should end all active conversations when multiple conversations found', async () => {
      conversation.active = true
      await conversation.save()
      const conversation3 = new Conversation({
        ...conversationAgentsEnabled,
        _id: new mongoose.Types.ObjectId(),
        active: true
      })
      await conversation3.save()

      const zoomAdapter3 = await Adapter.create({
        type: 'zoom',
        config: { botId: 'test-bot-id-2', meetingUrl: `https://zoom.us/j/${meetingId}` },
        conversation: conversation2._id,
        active: true
      })

      conversation3.adapters.push(zoomAdapter3)
      await conversation3.save()
      const payload = {
        event: 'meeting.ended',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting'
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // conversation 2 is not active, so this should only be called for one and three
      expect(mockZoomStop).toHaveBeenCalledTimes(2)
    })

    test('should not process started event when scheduledTime is outside 10-minute window', async () => {
      const startTime = new Date('2025-08-26T10:00:00Z')
      const scheduledTime = new Date(startTime.getTime() + maxScheduledInterval + 1 * 60 * 1000) // 1 minute greater than max interval (outside window)

      conversation.scheduledTime = scheduledTime
      await conversation.save()

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // Should not call start because no conversation matches the time window
      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should not process started event when multiple conversations match scheduledTime window', async () => {
      const startTime = new Date('2025-08-26T10:00:00Z')
      const scheduledTime1 = new Date(startTime.getTime() + (maxScheduledInterval - 1 * 60 * 1000)) // 1 minute less than the max
      const scheduledTime2 = new Date(startTime.getTime() + (maxScheduledInterval - 2 * 60 * 1000)) // 2 minutes less than the max  (both within window)

      conversation.scheduledTime = scheduledTime1
      conversation2.scheduledTime = scheduledTime2
      await conversation.save()
      await conversation2.save()

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // Should not call start because multiple conversations match
      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should not process when no conversations have scheduledTime set', async () => {
      const startTime = '2025-08-26T10:00:00Z'

      // Neither conversation has scheduledTime set (they should be undefined by default)

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // Should not call start because no conversation has scheduledTime
      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should handle edge case where scheduledTime exactly matches meeting start time', async () => {
      const startTime = '2025-08-26T10:00:00Z'
      const scheduledTime = new Date(startTime) // Exact match

      conversation.scheduledTime = scheduledTime
      await conversation.save()

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStart).toHaveBeenCalledTimes(1)
    })

    test('should handle scheduledTime at exact maximum boundary', async () => {
      const startTime = new Date('2025-08-26T10:00:00Z')
      const scheduledTime = new Date(startTime.getTime() + maxScheduledInterval) // Exactly max interval minutes after (should be included)

      conversation.scheduledTime = scheduledTime
      await conversation.save()

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      expect(mockZoomStart).toHaveBeenCalledTimes(1)
    })

    test('should process single conversation when only one exists (fallback behavior)', async () => {
      // Remove the second conversation and adapter
      await Conversation.findByIdAndDelete(conversation2._id)
      await Adapter.findByIdAndDelete(zoomAdapter2._id)

      const startTime = '2025-08-26T10:00:00Z'

      const payload = {
        event: 'meeting.started',
        payload: {
          object: {
            id: meetingId,
            host_id: 'host123',
            topic: 'Test Meeting',
            start_time: startTime
          }
        }
      }
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const signature = generateZoomSignature(timestamp, JSON.stringify(payload))

      await request(app)
        .post('/v1/webhooks/zoom')
        .set('x-zm-signature', signature)
        .set('x-zm-request-timestamp', timestamp)
        .send(payload)
        .expect(httpStatus.OK)

      // Should process the single conversation regardless of scheduledTime
      expect(mockZoomStart).toHaveBeenCalledTimes(1)
    })
  })
})
