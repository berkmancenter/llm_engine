import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Conversation } from '../../src/models/index.js'
import { insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Adapter from '../../src/models/adapter.model.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import slackClientPool from '../../src/adapters/slack/slackClientPool.js'

import { Direction } from '../../src/types/index.types.js'

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

    describe('bot mention normalization', () => {
      async function createConversationWithBot(name) {
        const conversationConfig = {
          name,
          owner: user1._id,
          topic: publicTopic._id,
          enableAgents: true,
          enableDMs: ['agents'],
          agents: [],
          messages: []
        }
        const conv = new Conversation(conversationConfig)
        await conv.save()
        const adapterWithBot = await Adapter.create({
          type: 'slack',
          conversation: conv,
          config: {
            channel: '#test-channel',
            botToken: 'xoxb-test-token',
            workspace: 'T123456789',
            botUserId: 'U99999BOT',
            botName: 'Berkie'
          },
          active: true
        })
        adapterWithBot.chatChannels = [{ name: 'general', direction: Direction.BOTH }]
        adapterWithBot.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId(), direction: Direction.BOTH }]
        return adapterWithBot
      }

      it('replaces &lt;@botUserId&gt; with @botName in group chat messages', async () => {
        const adapterWithBot = await createConversationWithBot('Bot Mention Test')
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'hey &lt;@U99999BOT&gt; what is the weather?',
          channel: '#test-channel',
          ts: '1234567890.123456'
        }
        const msgs = await adapterWithBot.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('hey @Berkie what is the weather?')
      })

      it('replaces &lt;@botUserId> (closing bracket not encoded) with @botName', async () => {
        const adapterWithBot = await createConversationWithBot('Bot Mention Test 2')
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'hello &lt;@U99999BOT> how are you?',
          channel: '#test-channel',
          ts: '1234567890.123456'
        }
        const msgs = await adapterWithBot.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('hello @Berkie how are you?')
      })

      it('replaces <@botUserId> (neither bracket encoded) with @botName', async () => {
        const adapterWithBot = await createConversationWithBot('Bot Mention Test 3')
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'hi <@U99999BOT> can you help?',
          channel: '#test-channel',
          ts: '1234567890.123456'
        }
        const msgs = await adapterWithBot.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('hi @Berkie can you help?')
      })

      it('replaces multiple bot mentions in a single message', async () => {
        const adapterWithBot = await createConversationWithBot('Bot Mention Test 4')
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: '&lt;@U99999BOT> said hi, then &lt;@U99999BOT> said bye',
          channel: '#test-channel',
          ts: '1234567890.123456'
        }
        const msgs = await adapterWithBot.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('@Berkie said hi, then @Berkie said bye')
      })

      it('does not modify other user mentions', async () => {
        const adapterWithBot = await createConversationWithBot('Bot Mention Test 5')
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: '&lt;@U999OTHER> said hi to &lt;@U99999BOT>',
          channel: '#test-channel',
          ts: '1234567890.123456'
        }
        const msgs = await adapterWithBot.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('&lt;@U999OTHER> said hi to @Berkie')
      })

      it('does not normalize when botUserId is not configured', async () => {
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'hey &lt;@U99999BOT> help?',
          channel: '#test-channel',
          ts: '1234567890.123456'
        }
        await createConversation('No Bot Config')
        adapter.chatChannels = [{ name: 'general' }]
        const msgs = await adapter.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('hey &lt;@U99999BOT> help?')
      })

      it('normalizes bot mention in DM messages', async () => {
        const adapterWithBot = await createConversationWithBot('Bot Mention DM Test')
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: '&lt;@U99999BOT> help me',
          channel: 'D123456789',
          channel_type: 'im',
          ts: '1234567890.123456'
        }
        const msgs = await adapterWithBot.receiveMessage(slackEvent)
        expect(msgs[0].message).toBe('@Berkie help me')
      })
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
