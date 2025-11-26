import faker from 'faker'
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import { Channel, Conversation } from '../../src/models/index.js'
import { insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Adapter from '../../src/models/adapter.model.js'

import config from '../../src/config/config.js'
import logger from '../../src/config/logger.js'
import { Direction } from '../../src/types/index.types.js'

jest.setTimeout(120000)

// Mock fetch for sendMessage tests
global.fetch = jest.fn()

setupIntTest()

describe('zoom adapter tests', () => {
  let conversation
  let adapter
  let user1

  async function createUser(pseudonym) {
    return {
      _id: new mongoose.Types.ObjectId(),
      username: faker.name.findName(),
      email: faker.internet.email().toLowerCase(),
      password: 'password1',
      role: 'user',
      isEmailVerified: false,
      pseudonyms: [
        {
          _id: new mongoose.Types.ObjectId(),
          token: '31c5d2b7d2b0f86b2b4b204',
          pseudonym,
          active: 'true'
        }
      ]
    }
  }

  async function createConversation(name) {
    const conversationConfig = {
      name,
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      agents: [],
      messages: []
    }
    conversation = new Conversation(conversationConfig)
    await conversation.save()
    adapter = await Adapter.create({
      type: 'zoom',
      conversation,
      config: {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      },
      active: true
    })
    conversation.adapters.push(adapter)

    await conversation.save()
  }

  beforeEach(async () => {
    user1 = await createUser('Boring Badger')
    await insertUsers([user1])
    await insertTopics([publicTopic])
    jest.clearAllMocks()
  })

  it('throws an error if no meeting URL specified in adapter config', async () => {
    await createConversation('The Future of Social Media')
    adapter.config = { botId: 'test-bot-id-123' }
    await expect(adapter.save()).rejects.toThrow('Zoom meeting URL required in adapter config')
  })

  describe('receiveAudio', () => {
    it('correctly creates and stores messages from an incoming transcript', async () => {
      await createConversation('The Future of Social Media')
      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      adapter.audioChannels = [{ name: 'transcript' }]

      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const message = {
        data: {
          data: {
            words: [
              {
                text: 'Welcome to the meeting!',
                end_timestamp: {
                  absolute: '2025-05-16T19:32:54.522382Z'
                }
              },
              {
                text: 'Great to see everyone!',
                end_timestamp: {
                  absolute: '2025-05-16T19:33:20.522382Z'
                }
              }
            ],
            participant: {
              id: 100,
              name: 'Jennifer Hickey',
              is_host: true,
              platform: 'unknown',
              extra_data: null
            }
          }
        },
        event: 'transcript.data'
      }
      const message2 = {
        data: {
          data: {
            words: [
              {
                text: 'Welcome to our special guest!',
                end_timestamp: {
                  absolute: '2025-05-16T19:33:55.522382Z'
                }
              }
            ],
            participant: {
              id: 100,
              name: 'Jennifer Hickey',
              is_host: true,
              platform: 'unknown',
              extra_data: null
            }
          }
        },
        event: 'transcript.data'
      }
      const message3 = {
        data: {
          data: {
            words: [
              {
                text: 'Happy to be here!',
                end_timestamp: {
                  absolute: '2025-05-16T19:34:43.522382Z'
                }
              }
            ],
            participant: {
              id: 101,
              name: 'John Doe',
              is_host: false,
              platform: 'unknown',
              extra_data: null
            }
          }
        },
        event: 'transcript.data'
      }
      const expectedMsg1 = {
        message: 'Welcome to the meeting!',
        source: 'zoom',
        user: { username: 'Jennifer Hickey' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:32:54.522382Z')
      }
      const expectedMsg2 = {
        message: 'Great to see everyone!',
        source: 'zoom',
        user: { username: 'Jennifer Hickey' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:33:20.522382Z')
      }
      const expectedMsg3 = {
        message: 'Welcome to our special guest!',
        source: 'zoom',
        user: { username: 'Jennifer Hickey' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:33:55.522382Z')
      }
      const expectedMsg4 = {
        message: 'Happy to be here!',
        source: 'zoom',
        user: { username: 'John Doe' },
        channels: adapter.audioChannels,
        createdAt: new Date('2025-05-16T19:34:43.522382Z')
      }
      const msgs1 = await adapter.receiveMessage(message)
      const msgs2 = await adapter.receiveMessage(message2)
      const msgs3 = await adapter.receiveMessage(message3)

      expect(msgs1).toHaveLength(2)
      expect(msgs1[0]).toEqual(expectedMsg1)
      expect(msgs1[1]).toEqual(expectedMsg2)
      expect(msgs2).toEqual([expectedMsg3])
      expect(msgs3).toEqual([expectedMsg4])
    })
  })

  describe('receiveChatMessage', () => {
    it('correctly processes chat messages sent to everyone using chatChannels', async () => {
      await createConversation('Meeting with Chat')

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const msgs = await adapter.receiveMessage(chatMessage)
      expect(msgs).toEqual([
        {
          message: 'Hello everyone!',
          source: 'zoom',
          user: { username: 'Alice Smith' },
          channels: adapter.chatChannels
        }
      ])
    })

    it('correctly processes DM messages with direct channel when enabled', async () => {
      await createConversation('Meeting with Direct Channel')

      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      const agentId = new mongoose.Types.ObjectId()
      adapter.dmChannels = [{ name: 'participant' }, { direct: true, agent: agentId }]
      await adapter.save()

      conversation.enableDMs = ['agents']
      await conversation.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const msgs = await adapter.receiveMessage(chatMessage)

      expect(msgs).toEqual([
        {
          message: 'Hello bot, can you help me?',
          source: 'zoom',
          channels: adapter.dmChannels,
          user: { username: 'Alice Smith', dmConfig: { to: 102 } }
        }
      ])
    })

    it('does not process chat messages when no chatChannels configured', async () => {
      await createConversation('Meeting without Chat Channels')

      // Remove chatChannels from config
      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      await adapter.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello everyone!',
              to: 'everyone'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const msgs = await adapter.receiveMessage(chatMessage)

      expect(msgs).toHaveLength(0)
    })

    it('does not process DM messages when no dmChannels configured', async () => {
      await createConversation('Meeting without DM Channels')

      // Remove dmChannels from config
      adapter.config = {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://zoom.meeting.com'
      }
      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'Hello bot, can you help me?',
              to: 'only_bot'
            },
            participant: {
              id: 102,
              name: 'Alice Smith',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      const msgs = await adapter.receiveMessage(chatMessage)

      expect(msgs).toHaveLength(0)
    })
  })

  describe('sendMessage', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully sends direct message', async () => {
      await createConversation('Test Meeting with Direct Channel')
      conversation.enableDMs = ['agents']

      const agentId = new mongoose.Types.ObjectId()
      adapter.dmChannels = [
        { name: 'participant' },
        { direct: true, agent: agentId, direction: Direction.BOTH, config: { direct1: { to: 'Alice Smith' } } }
      ]

      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const message = {
        body: 'Direct message to Alice',
        channels: ['direct1']
      }

      await adapter.sendMessage(message)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: 'Direct message to Alice',
          to: 'Alice Smith'
        })
      })
    })

    it('successfully sends non-direct message', async () => {
      await createConversation('Test Meeting with Group Channel')
      conversation.enableDMs = ['agents']

      const mockResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({ success: true })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const message = {
        body: 'Hello everyone!',
        channels: ['participant']
      }

      await adapter.sendMessage(message)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/test-bot-id-123/send_chat_message/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          message: 'Hello everyone!'
        })
      })
    })

    it('throws error when API returns non-200 status', async () => {
      await createConversation('Test Meeting')

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Bad Request')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const message = {
        body: 'Test message',
        channels: ['participant']
      }

      await expect(adapter.sendMessage(message)).rejects.toThrow('Error sending chat message to Zoom meeting: 400')
    })

    it('handles network errors gracefully', async () => {
      await createConversation('Test Meeting')
      ;(fetch as jest.Mock).mockRejectedValue(new Error('Network error'))

      adapter.chatChannels = [{ name: 'participant', direction: Direction.OUTGOING }]

      const message = {
        body: 'Test message',
        channels: ['participant']
      }

      await expect(adapter.sendMessage(message)).rejects.toThrow('Network error')
    })
  })

  describe('start method', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully deploys meeting bot with basic configuration and no audioChannels', async () => {
      await createConversation('Basic Meeting')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false
      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-id-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          meeting_url: 'https://zoom.us/j/123456789',
          bot_name: 'LLM Engine',
          recording_config: {
            realtime_endpoints: [
              {
                type: 'webhook',
                events: ['participant_events.chat_message'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/chat/?token=${config.recall.token}&conversationId=${conversation._id}`
              },
              {
                type: 'webhook',
                events: ['participant_events.join'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/join/?token=${config.recall.token}&conversationId=${conversation._id}`
              }
            ],
            retention: {
              type: 'timed',
              hours: 1
            }
          },
          ...(config.zoom?.webinarUserEmail && {
            zoom: {
              user_email: config.zoom.webinarUserEmail
            }
          })
        })
      })

      // Check that bot ID was saved to adapter config
      expect(adapter.config.botId).toBe('new-bot-id-123')
    })

    it('successfully deploys meeting bot with custom retention policy', async () => {
      await createConversation('Basic Meeting')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        retention: null
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false
      const channel = await Channel.create({ name: 'participant', adapterConfigs: [{ adapter: adapter._id }] })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-id-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: JSON.stringify({
          meeting_url: 'https://zoom.us/j/123456789',
          bot_name: 'LLM Engine',
          recording_config: {
            realtime_endpoints: [
              {
                type: 'webhook',
                events: ['participant_events.chat_message'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/chat/?token=${config.recall.token}&conversationId=${conversation._id}`
              },
              {
                type: 'webhook',
                events: ['participant_events.join'],
                url: `${config.recall.endpointBaseUrl}/v1/webhooks/recall/join/?token=${config.recall.token}&conversationId=${conversation._id}`
              }
            ],
            retention: null
          },
          ...(config.zoom?.webinarUserEmail && {
            zoom: {
              user_email: config.zoom.webinarUserEmail
            }
          })
        })
      })
    })

    it('deploys bot with transcript configuration when audioChannels are specified and channels exist', async () => {
      await createConversation('Meeting with Transcript')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/987654321'
      }
      adapter.audioChannels = [{ name: 'transcript' }]
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channels = await Channel.create([{ name: 'transcript' }, { name: 'participant' }])
      conversation.channels.push(...channels)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'transcript-bot-456' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, expect.objectContaining({ method: 'POST' }))
      expect(adapter.config.botId).toBe('transcript-bot-456')
    })

    it('does not enable transcription when audioChannels are specified but channels do not exist on conversation', async () => {
      await createConversation('Meeting with Missing Audio Channels')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/987654321'
      }
      adapter.audioChannels = [{ name: 'transcript' }]
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'no-transcript-bot-789' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, expect.objectContaining({ method: 'POST' }))
      expect(adapter.config.botId).toBe('no-transcript-bot-789')
    })

    it('throws error when API returns non-201 status', async () => {
      await createConversation('Failed Deployment')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/invalid'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Invalid meeting URL')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await expect(adapter.start()).rejects.toThrow('Error deploying bot to Zoom meeting: 400')
      expect(adapter.config.botId).toBeUndefined()
    })

    it('enables transcription with multiple audioChannels when all exist on conversation', async () => {
      await createConversation('Meeting with Multiple Audio Channels')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/987654321'
      }
      adapter.audioChannels = [{ name: 'transcript' }, { name: 'audio-log' }]
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channels = await Channel.create([{ name: 'transcript' }, { name: 'audio-log' }, { name: 'participant' }])
      conversation.channels.push(...channels)
      await conversation.save()

      const mockResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'multi-audio-bot-123' })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledWith(config.recall.baseUrl, expect.objectContaining({ method: 'POST' }))
      expect(adapter.config.botId).toBe('multi-audio-bot-123')
    })
    // Add these test cases to the existing 'start method' describe block

    it('skips deployment when bot is already deployed and active', async () => {
      await createConversation('Meeting with Active Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        botId: 'existing-bot-123'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock successful bot status check
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [
            { code: 'in_waiting_room', timestamp: '2024-01-01T10:00:00Z' },
            { code: 'in_call', timestamp: '2024-01-01T10:01:00Z' }
          ]
        })
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockStatusResponse)

      await adapter.start()

      // Should only call fetch once for status check, not for deployment
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/existing-bot-123`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: config.recall.key
        }
      })

      // Bot ID should remain unchanged
      expect(adapter.config.botId).toBe('existing-bot-123')
    })

    it('redeploys bot when existing bot status is "done"', async () => {
      await createConversation('Meeting with Done Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/123456789',
        botId: 'done-bot-456'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]
      adapter.active = false

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock bot status check showing "done" status
      const mockStatusResponse = {
        status: httpStatus.OK,
        json: jest.fn().mockResolvedValue({
          status_changes: [
            { code: 'in_call', timestamp: '2024-01-01T10:00:00Z' },
            { code: 'done', timestamp: '2024-01-01T10:30:00Z' }
          ]
        })
      }

      // Mock successful deployment response
      const mockDeployResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'new-bot-789' })
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockDeployResponse)

      await adapter.start()

      // Should call fetch twice: once for status check, once for deployment
      expect(fetch).toHaveBeenCalledTimes(2)

      // First call should be status check
      expect(fetch).toHaveBeenNthCalledWith(1, `${config.recall.baseUrl}/done-bot-456`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          Authorization: config.recall.key
        }
      })

      // Second call should be deployment
      expect(fetch).toHaveBeenNthCalledWith(2, config.recall.baseUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        },
        body: expect.stringContaining('"meeting_url":"https://zoom.us/j/123456789"')
      })

      // Bot ID should be updated to new bot
      expect(adapter.config.botId).toBe('new-bot-789')
    })

    it('redeploys bot when status check returns non-200 status', async () => {
      await createConversation('Meeting with Unreachable Bot')
      adapter.config = {
        meetingUrl: 'https://zoom.us/j/555666777',
        botId: 'unreachable-bot-404'
      }
      adapter.dmChannels = [{ name: 'participant' }]
      adapter.chatChannels = [{ name: 'participant' }]

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Mock failed status check
      const mockStatusResponse = {
        status: httpStatus.NOT_FOUND,
        text: jest.fn().mockResolvedValue('Bot not found')
      }

      const mockDeployResponse = {
        status: httpStatus.CREATED,
        json: jest.fn().mockResolvedValue({ id: 'recovery-bot-222' })
      }

      ;(fetch as jest.Mock).mockResolvedValueOnce(mockStatusResponse).mockResolvedValueOnce(mockDeployResponse)

      await adapter.start()

      expect(fetch).toHaveBeenCalledTimes(2)
      expect(adapter.config.botId).toBe('recovery-bot-222')
    })
  })
  describe('stop method', () => {
    beforeEach(() => {
      ;(fetch as jest.Mock).mockClear()
    })

    it('successfully removes bot from Zoom meeting', async () => {
      await createConversation('Test Meeting for Stop')
      adapter.config.botId = 'active-bot-id-123'

      const mockResponse = {
        status: httpStatus.OK,
        text: jest.fn().mockResolvedValue('Bot removed successfully')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      await adapter.stop()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${config.recall.baseUrl}/active-bot-id-123/leave_call/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: config.recall.key
        }
      })
      // Ensure botId has been removed from config
      expect(adapter.config.botId).toBeUndefined()
    })

    it('logs error when API returns non-200 status but does not throw', async () => {
      await createConversation('Test Meeting for Failed Stop')
      adapter.config.botId = 'failed-bot-id-456'

      const mockResponse = {
        status: httpStatus.BAD_REQUEST,
        text: jest.fn().mockResolvedValue('Bot not found in meeting')
      }
      ;(fetch as jest.Mock).mockResolvedValue(mockResponse)

      const loggerSpy = jest.spyOn(logger, 'error').mockImplementation()

      // Should not throw an error
      await expect(adapter.stop()).resolves.toBeUndefined()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(loggerSpy).toHaveBeenCalledWith(
        'Error removing bot from Zoom meeting: 400. Recall error: Bot not found in meeting'
      )

      loggerSpy.mockRestore()
    })
  })
  describe('participantJoined', () => {
    it('configures user and direct channel when DMs are enabled', async () => {
      await createConversation('Meeting with DMs Enabled')
      conversation.enableDMs = ['agents']

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId(), direction: Direction.BOTH }]
      await adapter.save()

      const participant = {
        id: 200,
        name: 'New Joiner',
        is_host: false,
        platform: 'zoom'
      }

      const adapterUser = await adapter.participantJoined(participant)
      expect(adapterUser).toEqual({ username: 'New Joiner', dmConfig: { to: 200 } })
    })

    it('does not configure direct channel when DMs are not enabled', async () => {
      await createConversation('Meeting without DMs')

      // DMs not enabled - conversation.enableDMs defaults to empty array

      const participant = {
        id: 400,
        name: 'No DM User',
        is_host: false,
        platform: 'zoom'
      }

      const adapterUser = await adapter.participantJoined(participant)

      expect(adapterUser).toBeUndefined()
    })

    it('does not configure direct channel when participant is the default bot', async () => {
      await createConversation('Meeting with Default Bot')
      conversation.enableDMs = ['agents']

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId() }]
      await adapter.save()

      const botParticipant = {
        id: 600,
        name: 'LLM Engine', // This is the defaultBotName
        is_host: false,
        platform: 'zoom'
      }

      const adapterUser = await adapter.participantJoined(botParticipant)

      expect(adapterUser).toBeUndefined()
    })

    it('does not process participantJoined when participant is a configured bot', async () => {
      await createConversation('Meeting with Custom Bot Name')
      conversation.enableDMs = ['agents']

      // Create another adapter with custom bot name
      const adapter2 = await Adapter.create({
        type: 'zoom',
        conversation,
        config: {
          botId: 'custom-bot-id-789',
          meetingUrl: 'http://zoom.meeting.com',
          botName: 'Custom Meeting Assistant'
        },
        active: true
      })
      conversation.adapters.push(adapter2)
      await conversation.save()

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId() }]
      await adapter.save()

      const customBotParticipant = {
        id: 700,
        name: 'Custom Meeting Assistant', // This matches the configured botName
        is_host: false,
        platform: 'zoom'
      }
      const adapterUser = await adapter.participantJoined(customBotParticipant)
      expect(adapterUser).toBeUndefined()
    })
  })
  describe('validateBeforeUpdate method', () => {
    beforeEach(async () => {
      // Clean up any existing conversations
      await Conversation.deleteMany({})
      await Adapter.deleteMany({})
    })

    it('throws error when no meeting URL is specified in adapter config', async () => {
      await createConversation('Test Meeting')
      adapter.config = { botId: 'test-bot-id-123' }

      await expect(adapter.save()).rejects.toThrow('Zoom meeting URL required in adapter config')
    })
  })
})
