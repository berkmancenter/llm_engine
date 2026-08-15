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
import conversationService from '../../src/services/conversation.service/index.js'
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
  let updateTranscriptStatusSpy
  let participantLeftSpy
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
    updateTranscriptStatusSpy = jest.spyOn(conversationService, 'updateTranscriptStatus').mockResolvedValue()
    participantLeftSpy = jest.spyOn(webhookService, 'participantLeft').mockResolvedValue()
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
    test('should trigger redeploy and stop transcript when bot times out at max duration with active transcript', async () => {
      // Set conversation as active with active transcript so bot redeploy and transcript stop are triggered
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'timeout_exceeded_max_duration',
            message: 'Bot timed out at max duration'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'stopped')
      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy and stop transcript when no one joined yet with active transcript', async () => {
      // Set conversation as active with active transcript so bot redeploy and transcript stop are triggered
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
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

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'stopped')
      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy and stop transcript on bot_received_leave_call with active transcript', async () => {
      // Set conversation as active with active transcript so bot redeploy and transcript stop are triggered
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
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

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'stopped')
      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy and stop transcript on timeout_exceeded_in_call_not_recording with active transcript', async () => {
      // Set conversation as active with active transcript so bot redeploy and transcript stop are triggered
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'timeout_exceeded_in_call_not_recording',
            message: 'Bot timed out while not recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'stopped')
      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy but not stop transcript when transcript was already paused', async () => {
      // Set conversation as active with paused transcript
      conversation.active = true
      conversation.transcript = {
        status: 'paused'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.call_ended',
        data: {
          bot: { id: botId },
          data: {
            code: 'call_ended',
            sub_code: 'timeout_exceeded_max_duration',
            message: 'Bot timed out at max duration'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should trigger redeploy but not stop transcript when transcript was already stopped', async () => {
      // Set conversation as active with stopped transcript
      conversation.active = true
      conversation.transcript = {
        status: 'stopped'
      }
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

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
      expect(mockZoomStart).toHaveBeenCalled()
    })

    test('should not redeploy but should stop transcript when host ends call', async () => {
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()
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

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'stopped')
      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('should not redeploy but should stop transcript when bot is kicked', async () => {
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()
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

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'stopped')
      expect(mockZoomStart).not.toHaveBeenCalled()
    })

    test('stops instead of redeploying when the conversation is an on-demand email event', async () => {
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      conversation.source = { origin: 'emailOnDemand', messageId: 'MSG-1' }
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

      expect(mockZoomStart).not.toHaveBeenCalled()
      const updated = await Conversation.findById(conversation._id)
      expect(updated!.active).toBe(false)
      expect(updated!.endTime).toBeDefined()
      expect(updated!.transcript?.status).toBe('stopped')
    })
  })

  describe('bot.in_call_recording event', () => {
    test('should resume transcript when bot starts recording and transcript was paused', async () => {
      // Set conversation as active with paused transcript
      conversation.active = true
      conversation.transcript = {
        status: 'paused'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_recording',
            message: 'Bot is now recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'active')
    })

    test('should not update transcript status when already active', async () => {
      // Set conversation as active with active transcript
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_recording',
            message: 'Bot is now recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })

    test('should resume transcript when bot starts recording and transcript was stopped', async () => {
      // Set conversation as active with stopped transcript
      conversation.active = true
      conversation.transcript = {
        status: 'stopped'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_recording',
            message: 'Bot is now recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'active')
    })

    test('should not resume transcript when conversation is not active', async () => {
      // Set conversation as inactive
      conversation.active = false
      conversation.transcript = {
        status: 'paused'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_recording',
            message: 'Bot is now recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })

    test('should handle bot.in_call_recording when adapter not found', async () => {
      const nonExistentBotId = 'non-existent-bot-id'
      const statusChangeEvent = {
        event: 'bot.in_call_recording',
        data: {
          bot: { id: nonExistentBotId },
          data: {
            code: 'in_call_recording',
            message: 'Bot is now recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })
  })

  describe('bot.in_call_not_recording event', () => {
    test('should pause transcript when bot stops recording and transcript was active', async () => {
      // Set conversation as active with active transcript
      conversation.active = true
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_not_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_not_recording',
            message: 'Bot is not recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: conversation._id }), 'paused')
    })

    test('should not update transcript status when already paused', async () => {
      // Set conversation as active with paused transcript
      conversation.active = true
      conversation.transcript = {
        status: 'paused'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_not_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_not_recording',
            message: 'Bot is not recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })

    test('should not update transcript status when already stopped', async () => {
      // Set conversation as active with stopped transcript
      conversation.active = true
      conversation.transcript = {
        status: 'stopped'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_not_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_not_recording',
            message: 'Bot is not recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })

    test('should not pause transcript when conversation is not active', async () => {
      // Set conversation as inactive
      conversation.active = false
      conversation.transcript = {
        status: 'active'
      }
      await conversation.save()

      const statusChangeEvent = {
        event: 'bot.in_call_not_recording',
        data: {
          bot: { id: botId },
          data: {
            code: 'in_call_not_recording',
            message: 'Bot is not recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })

    test('should handle bot.in_call_not_recording when adapter not found', async () => {
      const nonExistentBotId = 'non-existent-bot-id'
      const statusChangeEvent = {
        event: 'bot.in_call_not_recording',
        data: {
          bot: { id: nonExistentBotId },
          data: {
            code: 'in_call_not_recording',
            message: 'Bot is not recording'
          }
        }
      }
      const headers = generateWebhookSignature(statusChangeEvent, config.recall.realtimeSecret)
      await request(app).post(`/v1/webhooks/recall`).set(headers).send(statusChangeEvent).expect(httpStatus.OK)

      expect(updateTranscriptStatusSpy).not.toHaveBeenCalled()
    })
  })

  describe('participant_events.leave event', () => {
    test('should call participantLeft with the adapter and participant from the payload', async () => {
      const participant = { id: 123, name: 'Leaving User', is_host: false }
      const participantLeftEvent = {
        event: 'participant_events.leave',
        data: {
          bot: { id: botId },
          data: { participant }
        }
      }
      const headers = generateWebhookSignature(participantLeftEvent, config.recall.realtimeSecret)
      await request(app)
        .post(`/v1/webhooks/recall?conversationId=${conversation._id}`)
        .set(headers)
        .send(participantLeftEvent)
        .expect(httpStatus.OK)

      expect(participantLeftSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: zoomAdapter._id }), participant)
    })
  })
})
