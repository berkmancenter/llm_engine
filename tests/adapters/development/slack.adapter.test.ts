import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { Conversation } from '../../../src/models/index.js'
import { insertUsers } from '../../fixtures/user.fixture.js'
import { publicTopic } from '../../fixtures/conversation.fixture.js'
import { insertTopics } from '../../fixtures/topic.fixture.js'
import Adapter from '../../../src/models/adapter.model.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import slackClientPool from '../../../src/adapters/development/slack/slackClientPool.js'

import { Direction } from '../../../src/types/index.types.js'

setupIntTest()
jest.setTimeout(120000)

// Create a mock WebClient class
const mockWebClient = {
  chat: {
    postMessage: jest.fn()
  }
}

describe('slack adapter tests', () => {
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

  async function createConversation(name, enableDMs: string[] = []) {
    const conversationConfig = {
      name,
      owner: user1._id,
      topic: publicTopic._id,
      enableAgents: true,
      enableDMs,
      agents: [],
      messages: []
    }
    conversation = new Conversation(conversationConfig)
    await conversation.save()
    adapter = await Adapter.create({
      type: 'slack',
      conversation,
      config: { channel: '#test-channel', botToken: 'xoxb-test-token', workspace: 'T123456789' },
      active: true
    })
    conversation.adapters.push(adapter)
    await conversation.save()
  }

  beforeEach(async () => {
    user1 = await createUser('test-user')
    await insertUsers([user1])
    await insertTopics([publicTopic])

    // Reset all mocks
    jest.clearAllMocks()

    // Mock websocketGateway to avoid actual websocket calls
    jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(slackClientPool, 'getClient').mockReturnValue(mockWebClient as any)
  })

  it('throws an error if channel is missing from Slack config', async () => {
    await createConversation('The Future of Social Media')
    adapter.config = { botToken: 'xoxb-test-token', workspace: 'T123456789' }
    await expect(adapter.save()).rejects.toThrow()
  })

  it('throws an error if workspace is missing from Slack config', async () => {
    await createConversation('The Future of Social Media')
    adapter.config = { botToken: 'xoxb-test-token', channel: 'C12345' }
    await expect(adapter.save()).rejects.toThrow()
  })

  it('throws an error if botToken is missing from Slack config', async () => {
    await createConversation('The Future of Social Media')
    adapter.config = { workspace: 'T123456789', channel: 'C12345' }
    await expect(adapter.save()).rejects.toThrow()
  })

  describe('sendMessage', () => {
    it('successfully sends message to Slack channel', async () => {
      await createConversation('Test Slack Conversation')

      adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]
      const mockResponse = {
        ok: true,
        ts: '1234567890.123456',
        channel: '#test-channel'
      }
      mockWebClient.chat.postMessage.mockResolvedValue(mockResponse)

      const message = {
        body: 'Hello from the bot!',
        channels: ['general']
      }
      await adapter.sendMessage(message)

      // Verify postMessage was called on the returned client
      expect(mockWebClient.chat.postMessage).toHaveBeenCalledTimes(1)
      expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
        channel: '#test-channel',
        text: 'Hello from the bot!'
      })
    })

    it('successfully sends direct messages to Slack channel', async () => {
      await createConversation('Test Slack Conversation')

      adapter.dmChannels = [{ name: 'dm-1', direction: Direction.BOTH, config: { channel: 'D123456789' } }]

      const mockResponse = {
        ok: true,
        ts: '1234567890.123456',
        channel: 'D123456789'
      }
      mockWebClient.chat.postMessage.mockResolvedValue(mockResponse)

      const message = {
        body: 'Hello from the bot!',
        channels: ['dm-1']
      }
      await adapter.sendMessage(message)

      expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'D123456789',
        text: 'Hello from the bot!'
      })
    })

    it('transforms @username mentions to Slack format', async () => {
      await createConversation('Test Slack Conversation')

      adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]

      const mockResponse = {
        ok: true,
        ts: '1234567890.123456',
        channel: '#test-channel'
      }
      mockWebClient.chat.postMessage.mockResolvedValue(mockResponse)

      const message = {
        body: 'Hello @john123 and @mary456!',
        channels: ['general']
      }
      await adapter.sendMessage(message)

      expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
        channel: '#test-channel',
        text: 'Hello <@john123> and <@mary456>!'
      })
    })

    it('handles Slack API errors gracefully', async () => {
      await createConversation('Test Slack Conversation')

      adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]

      const mockError = new Error('Slack API Error')
      mockWebClient.chat.postMessage.mockRejectedValue(mockError)

      const message = {
        body: 'Test message',
        channels: ['general']
      }

      await expect(adapter.sendMessage(message)).rejects.toThrow('Slack API Error')
    })

    it('handles message send errors gracefully', async () => {
      await createConversation('Test Slack Conversation')

      adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]
      const mockResponse = {
        ok: false,
        ts: '1234567890.123456',
        error: 'channel_not_found',
        channel: '#test-channel'
      }
      mockWebClient.chat.postMessage.mockResolvedValue(mockResponse)

      const message = {
        body: 'Hello from the bot!',
        channels: ['general']
      }
      await expect(adapter.sendMessage(message)).rejects.toThrow('Slack message failed to send: channel_not_found')

      expect(mockWebClient.chat.postMessage).toHaveBeenCalledTimes(1)
      expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
        channel: '#test-channel',
        text: 'Hello from the bot!'
      })
    })
  })

  describe('receiveMessage', () => {
    it('correctly processes incoming Slack group chat messages', async () => {
      await createConversation('Test Slack Conversation')

      adapter.chatChannels = [{ name: 'general' }]
      await adapter.save()

      const slackEvent = {
        user: 'U123456',
        team: 'T123456789',
        text: 'Hello from Slack!',
        channel: '#test-channel',
        ts: '1234567890.123456'
      }

      const msgs = await adapter.receiveMessage(slackEvent)
      expect(msgs).toEqual([
        {
          message: 'Hello from Slack!',
          source: 'slack',
          channels: adapter.chatChannels,
          user: { username: `${slackEvent.team}-${slackEvent.user}`, pseudonym: slackEvent.user }
        }
      ])
    })

    it('handles messages with special Slack formatting', async () => {
      await createConversation('Test Slack Conversation')
      adapter.chatChannels = [{ name: 'general' }]
      await adapter.save()

      const slackEvent = {
        user: 'U789012',
        team: 'T123456789',
        text: 'Hello <@U123456> and <#C789012|general>! Check out <https://example.com|this link>',
        channel: '#test-channel',
        ts: '1234567890.123456'
      }

      const msgs = await adapter.receiveMessage(slackEvent)
      expect(msgs).toEqual([
        {
          message: 'Hello <@U123456> and <#C789012|general>! Check out <https://example.com|this link>',
          source: 'slack',
          channels: adapter.chatChannels,
          user: { username: `${slackEvent.team}-${slackEvent.user}`, pseudonym: slackEvent.user }
        }
      ])
    })

    it('ignores group chat messages when no chat channels are configured', async () => {
      await createConversation('Test Slack Conversation')
      adapter.chatChannels = [] // No chat channels configured
      await adapter.save()

      const slackEvent = {
        user: 'U123456',
        team: 'T123456789',
        text: 'Hello from Slack!',
        channel: '#test-channel',
        ts: '1234567890.123456'
      }

      const msgs = await adapter.receiveMessage(slackEvent)
      expect(msgs).toHaveLength(0)
    })
  })

  describe('Direct Message (DM) handling', () => {
    it('processes DM when DMs are enabled', async () => {
      await createConversation('Test Slack Conversation', ['agents'])

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId(), direction: Direction.BOTH }]
      await adapter.save()

      const slackEvent = {
        user: 'U123456',
        team: 'T123456789',
        text: 'Hello via DM!',
        channel: 'D123456789',
        channel_type: 'im',
        ts: '1234567890.123456'
      }

      const msgs = await adapter.receiveMessage(slackEvent)
      expect(msgs).toEqual([
        {
          message: 'Hello via DM!',
          source: 'slack',
          channels: adapter.dmChannels,
          user: {
            username: `${slackEvent.team}-${slackEvent.user}`,
            pseudonym: slackEvent.user,
            dmConfig: { channel: 'D123456789' }
          }
        }
      ])
    })

    it('does not process DM when DMs are disabled', async () => {
      await createConversation('Test Slack Conversation')

      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId(), direction: Direction.BOTH }]
      await adapter.save()

      const slackEvent = {
        user: 'U123456',
        team: 'T123456789',
        text: 'Hello via DM!',
        channel: 'D123456789',
        channel_type: 'im',
        ts: '1234567890.123456'
      }

      const msgs = await adapter.receiveMessage(slackEvent)
      expect(msgs).toHaveLength(0)
    })

    it('processes non-direct DM channel messages', async () => {
      await createConversation('Test Slack Conversation', ['agents'])
      adapter.dmChannels = [{ name: 'support-channel', direct: false }]
      await adapter.save()

      const slackEvent = {
        user: 'U123456',
        team: 'T123456789',
        text: 'Hello via non-direct DM!',
        channel: 'D123456789',
        channel_type: 'im',
        ts: '1234567890.123456'
      }

      const msgs = await adapter.receiveMessage(slackEvent)
      expect(msgs).toEqual([
        {
          message: 'Hello via non-direct DM!',
          source: 'slack',
          channels: adapter.dmChannels,
          user: {
            username: `${slackEvent.team}-${slackEvent.user}`,
            pseudonym: slackEvent.user,
            dmConfig: { channel: 'D123456789' }
          }
        }
      ])
    })
  })
})
