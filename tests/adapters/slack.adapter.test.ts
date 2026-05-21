import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Conversation, Message } from '../../src/models/index.js'
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
  auth: {
    test: jest.fn()
  },
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
    mockWebClient.auth.test.mockResolvedValue({ ok: true, user_id: 'U_AUTO_RESOLVED' })
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

  describe('botUserId auto-resolution', () => {
    it('calls auth.test() and persists botUserId when not provided in config', async () => {
      await createConversation('Auto Resolve Bot User ID')
      expect(mockWebClient.auth.test).toHaveBeenCalled()
      expect(adapter.config.botUserId).toBe('U_AUTO_RESOLVED')
    })

    it('does not call auth.test() when botUserId is already provided', async () => {
      const conversationConfig = {
        name: 'Explicit Bot User ID',
        owner: user1._id,
        topic: publicTopic._id,
        enableAgents: true,
        enableDMs: [],
        agents: [],
        messages: []
      }
      const conv = new Conversation(conversationConfig)
      await conv.save()
      jest.clearAllMocks()
      mockWebClient.auth.test.mockResolvedValue({ ok: true, user_id: 'U_SHOULD_NOT_BE_USED' })
      const adapterWithId = await Adapter.create({
        type: 'slack',
        conversation: conv,
        config: { channel: '#test', botToken: 'xoxb-test-token', workspace: 'T123456789', botUserId: 'U_EXPLICIT' },
        active: true
      })
      expect(mockWebClient.auth.test).not.toHaveBeenCalled()
      expect(adapterWithId.config.botUserId).toBe('U_EXPLICIT')
    })

    it('throws when auth.test() returns ok: false', async () => {
      mockWebClient.auth.test.mockResolvedValue({ ok: false, error: 'invalid_auth' })
      const conv = new Conversation({
        name: 'Auth Test Failure',
        owner: user1._id,
        topic: publicTopic._id,
        enableAgents: true,
        enableDMs: [],
        agents: [],
        messages: []
      })
      await conv.save()
      await expect(
        Adapter.create({
          type: 'slack',
          conversation: conv,
          config: { channel: '#test', botToken: 'xoxb-bad-token', workspace: 'T123456789' },
          active: true
        })
      ).rejects.toThrow('Failed to look up Slack bot user ID: invalid_auth')
    })

    it('throws when auth.test() returns no user_id', async () => {
      mockWebClient.auth.test.mockResolvedValue({ ok: true })
      const conv = new Conversation({
        name: 'Auth No User ID',
        owner: user1._id,
        topic: publicTopic._id,
        enableAgents: true,
        enableDMs: [],
        agents: [],
        messages: []
      })
      await conv.save()
      await expect(
        Adapter.create({
          type: 'slack',
          conversation: conv,
          config: { channel: '#test', botToken: 'xoxb-test-token', workspace: 'T123456789' },
          active: true
        })
      ).rejects.toThrow('Failed to look up Slack bot user ID')
    })
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

    describe('markdown to mrkdwn conversion', () => {
      async function sendAndGetText(body: string): Promise<string> {
        await createConversation('Markdown Test Conversation')
        adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]
        mockWebClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456', channel: '#test-channel' })
        await adapter.sendMessage({ body, channels: ['general'] })
        return mockWebClient.chat.postMessage.mock.calls[0][0].text
      }

      it('converts **bold** to *bold*', async () => {
        expect(await sendAndGetText('**hello**')).toBe('*hello*')
      })

      it('converts __bold__ to *bold*', async () => {
        expect(await sendAndGetText('__hello__')).toBe('*hello*')
      })

      it('converts *italic* to _italic_', async () => {
        expect(await sendAndGetText('*hello*')).toBe('_hello_')
      })

      it('converts ~~strikethrough~~ to ~strikethrough~', async () => {
        expect(await sendAndGetText('~~hello~~')).toBe('~hello~')
      })

      it('converts # heading to *heading*', async () => {
        expect(await sendAndGetText('# My Heading')).toBe('*My Heading*')
      })

      it('converts [text](url) links to <url|text>', async () => {
        expect(await sendAndGetText('[click here](https://example.com)')).toBe('<https://example.com|click here>')
      })

      it('converts ***bold italic*** to *_bold italic_*', async () => {
        expect(await sendAndGetText('***hello***')).toBe('*_hello_*')
      })

      it('converts ___bold italic___ to *_bold italic_*', async () => {
        expect(await sendAndGetText('___hello___')).toBe('*_hello_*')
      })

      it('does not double-convert — bold is not re-processed as italic', async () => {
        expect(await sendAndGetText('**word**')).toBe('*word*')
      })

      it('leaves backtick code spans unchanged', async () => {
        expect(await sendAndGetText('use `console.log`')).toBe('use `console.log`')
      })

      it('handles mixed formatting in a single message', async () => {
        expect(await sendAndGetText('**bold** and *italic* and ~~strike~~')).toBe('*bold* and _italic_ and ~strike~')
      })
    })

    describe('Slack user ID mention formatting', () => {
      async function sendAndGetText(body: string): Promise<string> {
        await createConversation('Mention Test Conversation')
        adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]
        mockWebClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456', channel: '#test-channel' })
        await adapter.sendMessage({ body, channels: ['general'] })
        return mockWebClient.chat.postMessage.mock.calls[0][0].text
      }

      it('wraps @-prefixed Slack user IDs in <@...>', async () => {
        expect(await sendAndGetText('Hello @U123456 and @UABC789XYZ!')).toBe('Hello <@U123456> and <@UABC789XYZ>!')
      })

      it('wraps bare Slack user IDs (no @ prefix) in <@...>', async () => {
        expect(await sendAndGetText('Hello U123456 and UABC789XYZ!')).toBe('Hello <@U123456> and <@UABC789XYZ>!')
      })

      it('does not double-wrap already-formatted <@USER_ID> mentions', async () => {
        expect(await sendAndGetText('Hello <@U123456>!')).toBe('Hello <@U123456>!')
      })

      it('leaves non-ID @mentions unchanged', async () => {
        expect(await sendAndGetText('Hello @john and @mary!')).toBe('Hello @john and @mary!')
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

    describe('Slack Block Kit UI blocks support', () => {
      beforeEach(async () => {
        await createConversation('Block Kit Test Conversation')
        adapter.chatChannels = [{ name: 'general', direction: Direction.OUTGOING }]
        mockWebClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '1234567890.123456', channel: '#test-channel' })
      })

      it('includes Block Kit blocks array in Slack API call when message has blocks', async () => {
        const blocks = [
          { type: 'section', text: { type: 'mrkdwn', text: 'Pick an option:' } },
          {
            type: 'actions',
            elements: [{ type: 'button', text: { type: 'plain_text', text: 'Confirm' }, action_id: 'confirm', value: 'yes' }]
          }
        ]
        await adapter.sendMessage({ body: 'Pick an option:', channels: ['general'], blocks })

        expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ blocks }))
      })

      it('sends message without blocks key when no blocks are attached', async () => {
        await adapter.sendMessage({ body: 'Hello!', channels: ['general'] })

        const call = mockWebClient.chat.postMessage.mock.calls[0][0]
        expect(call).not.toHaveProperty('blocks')
      })

      it('sends message without blocks key when blocks array is empty', async () => {
        await adapter.sendMessage({ body: 'Hello!', channels: ['general'], blocks: [] })

        const call = mockWebClient.chat.postMessage.mock.calls[0][0]
        expect(call).not.toHaveProperty('blocks')
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
          source: {
            type: 'slack',
            id: slackEvent.ts,
            userId: slackEvent.user,
            teamId: slackEvent.team,
            channelId: slackEvent.channel
          },
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
          source: {
            type: 'slack',
            id: slackEvent.ts,
            userId: slackEvent.user,
            teamId: slackEvent.team,
            channelId: slackEvent.channel
          },
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
          source: { type: 'slack', id: slackEvent.ts },
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
          source: { type: 'slack', id: slackEvent.ts },
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

  describe('threading', () => {
    const threadRootId = new mongoose.Types.ObjectId()

    beforeEach(async () => {
      await createConversation('Threading Test Conversation', ['agents'])
      adapter.chatChannels = [{ name: 'general', direction: Direction.BOTH }]
      adapter.dmChannels = [{ direct: true, agent: new mongoose.Types.ObjectId(), direction: Direction.BOTH }]
      mockWebClient.chat.postMessage.mockResolvedValue({ ok: true, ts: '9999999999.000000', channel: '#test-channel' })
    })

    describe('receiveMessage', () => {
      it('sets parentMessage on a threaded group chat reply', async () => {
        jest.spyOn(Message, 'findOne').mockReturnValue({ select: () => ({ exec: async () => ({ _id: threadRootId }) }) })
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'This is a reply',
          channel: '#test-channel',
          ts: '2222222222.222222',
          thread_ts: '1111111111.111111'
        }
        const msgs = await adapter.receiveMessage(slackEvent)
        expect(msgs[0].parentMessage).toBe(threadRootId.toString())
      })

      it('sets parentMessage on a threaded DM reply', async () => {
        jest.spyOn(Message, 'findOne').mockReturnValue({ select: () => ({ exec: async () => ({ _id: threadRootId }) }) })
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'DM reply in thread',
          channel: 'D123456789',
          channel_type: 'im',
          ts: '2222222222.222222',
          thread_ts: '1111111111.111111'
        }
        const msgs = await adapter.receiveMessage(slackEvent)
        expect(msgs[0].parentMessage).toBe(threadRootId.toString())
      })

      it('does not set parentMessage when thread_ts equals ts (root message)', async () => {
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'Starting a thread',
          channel: '#test-channel',
          ts: '3333333333.333333',
          thread_ts: '3333333333.333333'
        }
        const msgs = await adapter.receiveMessage(slackEvent)
        expect(msgs[0].parentMessage).toBeUndefined()
      })

      it('does not set parentMessage when thread_ts is absent', async () => {
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'Regular message',
          channel: '#test-channel',
          ts: '3333333333.333333'
        }
        const msgs = await adapter.receiveMessage(slackEvent)
        expect(msgs[0].parentMessage).toBeUndefined()
      })

      it('does not set parentMessage when thread_ts does not match any stored message', async () => {
        jest.spyOn(Message, 'findOne').mockReturnValue({ select: () => ({ exec: async () => null }) })
        const slackEvent = {
          user: 'U123456',
          team: 'T123456789',
          text: 'Reply to unknown thread',
          channel: '#test-channel',
          ts: '2222222222.222222',
          thread_ts: '9999999999.999999'
        }
        const msgs = await adapter.receiveMessage(slackEvent)
        expect(msgs[0].parentMessage).toBeUndefined()
      })
    })

    describe('sendMessage', () => {
      let findByIdAndUpdateMock

      beforeEach(() => {
        findByIdAndUpdateMock = jest.spyOn(Message, 'findByIdAndUpdate').mockReturnValue({ exec: jest.fn() })
      })

      it('sends with thread_ts when message has a parentMessage', async () => {
        jest.spyOn(Message, 'findById').mockReturnValue({
          select: () => ({ exec: async () => ({ source: { type: 'slack', id: '1111111111.111111' } }) })
        })
        const message = { body: 'Bot reply in thread', channels: ['general'], parentMessage: threadRootId }
        await adapter.sendMessage(message)
        expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
          channel: '#test-channel',
          text: 'Bot reply in thread',
          thread_ts: '1111111111.111111'
        })
      })

      it('sends without thread_ts when message has no parentMessage', async () => {
        const message = { body: 'Top-level bot message', channels: ['general'] }
        await adapter.sendMessage(message)
        expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
          channel: '#test-channel',
          text: 'Top-level bot message'
        })
      })

      it('sends without thread_ts when parent has no source id', async () => {
        jest
          .spyOn(Message, 'findById')
          .mockReturnValue({ select: () => ({ exec: async () => ({ source: { type: 'zoom' } }) }) })
        const message = { body: 'Reply to non-slack parent', channels: ['general'], parentMessage: threadRootId }
        await adapter.sendMessage(message)
        expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
          channel: '#test-channel',
          text: 'Reply to non-slack parent'
        })
      })

      it('updates source.id with Slack ts after successful send', async () => {
        const messageId = new mongoose.Types.ObjectId()
        const message = { _id: messageId, body: 'Agent message', channels: ['general'] }
        await adapter.sendMessage(message)
        expect(findByIdAndUpdateMock).toHaveBeenCalledWith(messageId, { $set: { 'source.id': '9999999999.000000' } })
      })

      it('does not update source.id when message has no _id', async () => {
        const message = { body: 'Transient message', channels: ['general'] }
        await adapter.sendMessage(message)
        expect(findByIdAndUpdateMock).not.toHaveBeenCalled()
      })
    })
  })
})
