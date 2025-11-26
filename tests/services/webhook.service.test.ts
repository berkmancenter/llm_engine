import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Conversation, Channel, User, Agent } from '../../src/models/index.js'
import { insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import logger from '../../src/config/logger.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { Direction } from '../../src/types/index.types.js'
import webhookService from '../../src/services/webhook.service.js'
import defaultAdapterTypes from '../../src/adapters/index.js'

jest.setTimeout(120000)

setupIntTest()
const testAgentTypeSpecification = {
  test: {
    name: 'Test Agent',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessage: 2, directMessages: true } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    useTranscriptRAGCollection: true
  }
}

// Create mock adapter type
const mockAdapterType = {
  receiveMessage: jest.fn(),
  participantJoined: jest.fn()
}
const testAdapterTypes = {
  test: mockAdapterType
}

describe('adapter service tests', () => {
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
      type: 'test',
      conversation,
      config: {
        botId: 'test-bot-id-123',
        meetingUrl: 'http://test.meeting.com'
      },
      active: true
    })
    // Add mock methods to the adapter instance
    adapter.receiveMessage = mockAdapterType.receiveMessage
    adapter.participantJoined = mockAdapterType.participantJoined

    conversation.adapters.push(adapter)
    await conversation.save()
  }

  beforeAll(() => {
    setAgentTypes(testAgentTypeSpecification)
    setAdapterTypes(testAdapterTypes)
  })

  beforeEach(async () => {
    user1 = await createUser('Boring Badger')
    await insertUsers([user1])
    await insertTopics([publicTopic])
    jest.clearAllMocks()
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
    setAdapterTypes(defaultAdapterTypes)
  })

  describe('receiveMessage', () => {
    it('correctly creates and stores messages from an incoming transcript', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

      await createConversation('The Future of Social Media')
      adapter.audioChannels = [{ name: 'transcript' }]
      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      const channel = await Channel.create({ name: 'transcript' })
      conversation.channels.push(channel)
      await conversation.save()

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

      // Mock the receiveMessage to return expected AdapterMessage format
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Jennifer Hickey', pseudonym: null },
          channels: [{ name: 'transcript', direct: false }],
          message: 'Welcome to the meeting!',
          source: 'test',
          messageType: 'text',
          createdAt: new Date('2025-05-16T19:32:54.522382Z')
        },
        {
          user: { username: 'Jennifer Hickey', pseudonym: null },
          channels: [{ name: 'transcript', direct: false }],
          message: 'Great to see everyone!',
          source: 'test',
          messageType: 'text',
          createdAt: new Date('2025-05-16T19:33:20.522382Z')
        }
      ])

      const expectedMsg1 = {
        body: 'Welcome to the meeting!',
        source: 'test',
        conversation: conversation._id,
        createdAt: new Date('2025-05-16T19:32:54.522382Z')
      }
      const expectedMsg2 = {
        body: 'Great to see everyone!',
        source: 'test',
        conversation: conversation._id,
        createdAt: new Date('2025-05-16T19:33:20.522382Z')
      }

      await webhookService.receiveMessage(adapter, message)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(message)
      expect(broadcastMsgSpy).toHaveBeenCalledTimes(2)

      await conversation.populate('messages')
      expect(conversation.messages).toHaveLength(2)
      expect(conversation.messages).toContainEqual(expect.objectContaining(expectedMsg1))
      expect(conversation.messages).toContainEqual(expect.objectContaining(expectedMsg2))
      expect(conversation.messages[0].channels).toHaveLength(1)
      expect(conversation.messages[0].channels[0]).toEqual('transcript')
    })
  })

  describe('receiveChatMessage', () => {
    it('correctly processes chat messages sent to everyone using chatChannels', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

      await createConversation('Meeting with Chat')
      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

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
              platform: 'test'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      adapter.chatChannels = [{ name: 'participant' }]
      await adapter.save()

      // Mock the receiveMessage to return expected AdapterMessage format
      const specificDate = new Date()
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Alice Smith', pseudonym: null },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello everyone!',
          source: 'test',
          messageType: 'text',
          createdAt: specificDate
        }
      ])

      await webhookService.receiveMessage(adapter, chatMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(chatMessage)
      expect(broadcastMsgSpy).toHaveBeenCalledTimes(1)
      await conversation.populate('messages')
      expect(conversation.messages).toHaveLength(1)
      expect(conversation.messages[0]).toEqual(
        expect.objectContaining({
          body: 'Hello everyone!',
          source: 'test',
          conversation: conversation._id,
          createdAt: specificDate
        })
      )
      expect(conversation.messages[0].channels).toHaveLength(1)
      expect(conversation.messages[0].channels[0]).toEqual('participant')
    })

    it('correctly processes DMs on non-direct channels', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

      await createConversation('Meeting with DM')

      adapter.dmChannels = [{ name: 'participant' }]
      await adapter.save()

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
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
              platform: 'test'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      // Mock the receiveMessage to return expected AdapterMessage format
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Alice Smith', pseudonym: null },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello bot, can you help me?',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, chatMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(chatMessage)
      expect(broadcastMsgSpy).toHaveBeenCalledTimes(1)
      await conversation.populate('messages')
      expect(conversation.messages).toHaveLength(1)
      expect(conversation.messages[0]).toEqual(
        expect.objectContaining({
          body: 'Hello bot, can you help me?',
          bodyType: 'text',
          source: 'test',
          conversation: conversation._id
        })
      )
      expect(conversation.messages[0].channels).toHaveLength(1)
      expect(conversation.messages[0].channels[0]).toEqual('participant')
    })

    it('correctly processes DM messages with direct channel', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

      await createConversation('Meeting with Direct Channel')
      const agent = new Agent({
        agentType: 'test',
        conversation
      })
      await agent.save()
      conversation.agents.push(agent)

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      // Configure adapter with direct channel in dmChannels
      adapter.dmChannels = [{ name: 'participant' }, { direct: true, agent: agent._id }]
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
              platform: 'test'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      // Mock the receiveMessage to return expected AdapterMessage format with direct channel
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Alice Smith', pseudonym: null, dmConfig: { to: 102 } },
          channels: [
            { name: 'participant', direct: false },
            { direct: true, agent: agent._id }
          ],
          message: 'Hello bot, can you help me?',
          source: 'test',
          messageType: 'text',
          createdAt: new Date()
        }
      ])

      await webhookService.receiveMessage(adapter, chatMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(chatMessage)
      expect(broadcastMsgSpy).toHaveBeenCalledTimes(1)
      await conversation.populate(['messages', 'channels'])
      expect(conversation.messages).toHaveLength(1)
      expect(conversation.messages[0]).toEqual(
        expect.objectContaining({
          body: 'Hello bot, can you help me?',
          source: 'test',
          conversation: conversation._id
        })
      )
      expect(conversation.messages[0].channels).toHaveLength(2)
      expect(conversation.messages[0].channels).toContainEqual('participant')

      const user = await User.findOne({ username: 'Alice Smith' })
      expect(conversation.messages[0].channels).toContainEqual(`direct-${user!._id}-${agent._id}`)
      const directChannel = await Channel.findOne({ name: `direct-${user!._id}-${agent._id}` })
      expect(directChannel).toBeTruthy()
      const modifiedAdapter = await Adapter.findById(adapter._id)
      const dmChannel = modifiedAdapter?.dmChannels?.find((c) => c.direct)
      expect(dmChannel!.config![`direct-${user!._id}-${agent._id}`]).toEqual({ to: 102 })
    })

    it('does not process chat messages when receiveMessage returns empty array', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

      await createConversation('Meeting without Chat Channels')

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

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
              platform: 'test'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      // Mock receiveMessage to return empty array (no processing)
      mockAdapterType.receiveMessage.mockResolvedValue([])

      await webhookService.receiveMessage(adapter, chatMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(chatMessage)
      expect(broadcastMsgSpy).not.toHaveBeenCalled()
    })

    it('warns when configured channels do not exist on conversation', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      const loggerSpy = jest.spyOn(logger, 'warn').mockImplementation()

      // Create conversation with no channels
      await createConversation('Meeting with Missing Channels')

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
              platform: 'test'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      // Mock receiveMessage to return a message for a channel that doesn't exist
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Alice Smith', pseudonym: null },
          channels: [{ name: 'nonexistent-channel', direct: false }],
          message: 'Hello everyone!',
          source: 'test',
          messageType: 'text',
          createdAt: new Date()
        }
      ])

      await webhookService.receiveMessage(adapter, chatMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(chatMessage)
      expect(broadcastMsgSpy).not.toHaveBeenCalled()
      expect(loggerSpy).toHaveBeenCalledWith(
        'Unable to receive message on specified channel nonexistent-channel. Channel not found in Conversation.'
      )

      loggerSpy.mockRestore()
    })

    it('creates new user if participant does not exist', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('Meeting with New Participant')

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const chatMessage = {
        data: {
          data: {
            data: {
              text: 'First time here!',
              to: 'everyone'
            },
            participant: {
              id: 999,
              name: 'New Participant',
              is_host: false,
              platform: 'test'
            }
          }
        },
        event: 'participant_events.chat_message'
      }

      // Mock receiveMessage to return a message from a new user
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'New Participant', pseudonym: null },
          channels: [{ name: 'participant', direct: false }],
          message: 'First time here!',
          source: 'test',
          messageType: 'text',
          createdAt: new Date()
        }
      ])

      await webhookService.receiveMessage(adapter, chatMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(chatMessage)
      expect(broadcastMsgSpy).toHaveBeenCalledTimes(1)
      await conversation.populate('messages')
      expect(conversation.messages).toHaveLength(1)

      const newUser = await User.findOne({ username: 'New Participant' })
      expect(newUser).toBeDefined()
      expect(newUser!.pseudonyms).toHaveLength(1)
      expect(newUser!.pseudonyms[0].active).toBe(true)
    })
  })

  describe('participantJoined', () => {
    it('creates user and direct channel when participant joins and DMs are enabled', async () => {
      await createConversation('Meeting with DMs Enabled')
      conversation.enableDMs = ['agents']

      const agent = new Agent({
        agentType: 'test',
        conversation
      })
      await agent.save()
      conversation.agents.push(agent)
      await conversation.save()

      adapter.dmChannels = [
        { direct: true, agent: agent._id, direction: Direction.BOTH, config: { 'direct-foo-bar': { to: 500 } } }
      ]

      await adapter.save()

      const participant = {
        id: 200,
        name: 'New Joiner',
        is_host: false,
        platform: 'test'
      }

      // Mock participantJoined to return expected AdapterUser format
      mockAdapterType.participantJoined.mockReturnValue({
        username: 'New Joiner',
        dmConfig: { to: 200 }
      })

      await webhookService.participantJoined(adapter, participant)

      expect(mockAdapterType.participantJoined).toHaveBeenCalledWith(participant)

      // Check that user was created
      const createdUser = await User.findOne({ username: 'New Joiner' })
      expect(createdUser).toBeDefined()
      expect(createdUser!.pseudonyms).toHaveLength(1)
      expect(createdUser!.pseudonyms[0].active).toBe(true)

      // Check that direct channel was created
      await conversation.populate('channels')
      const directChannel = conversation.channels.find((c) => c.name === `direct-${createdUser!._id}-${agent._id}`)
      expect(directChannel).toBeDefined()
      expect(directChannel.direct).toBe(true)
      expect(directChannel.passcode).toBeNull()
      const modifiedAdapter = await Adapter.findById(adapter._id)
      const dmChannel = modifiedAdapter?.dmChannels?.find((c) => c.direct)
      expect(dmChannel!.config![`direct-${createdUser!._id}-${agent._id}`]).toEqual({ to: 200 })
    })

    it('uses existing user when participant with same name joins', async () => {
      await createConversation('Meeting with Existing User')
      conversation.enableDMs = ['agents']
      const agent = new Agent({
        agentType: 'test',
        conversation
      })
      await agent.save()
      conversation.agents.push(agent)
      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      adapter.dmChannels = [{ direct: true, agent: agent._id }]
      await adapter.save()

      // Create existing user
      const existingUser = await User.create({
        username: 'Existing User',
        pseudonyms: [{ token: 'existing-token', pseudonym: 'Existing Pseudonym', active: true }]
      })

      const participant = {
        id: 300,
        name: 'Existing User',
        is_host: true,
        platform: 'test'
      }

      // Mock participantJoined to return expected AdapterUser format
      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Existing User',
        dmConfig: { to: 300 }
      })

      await webhookService.participantJoined(adapter, participant)

      expect(mockAdapterType.participantJoined).toHaveBeenCalledWith(participant)

      // Should not create a new user
      const users = await User.find({ username: 'Existing User' })
      expect(users).toHaveLength(1)
      expect(users[0]._id.toString()).toBe(existingUser._id.toString())

      // Should still create direct channel
      await conversation.populate('channels')
      const directChannel = conversation.channels.find((c) => c.name === `direct-${existingUser._id}-${agent._id}`)
      expect(directChannel).toBeDefined()
      expect(directChannel.direct).toBe(true)
      const modifiedAdapter = await Adapter.findById(adapter._id)
      const dmChannel = modifiedAdapter?.dmChannels?.find((c) => c.direct)
      expect(dmChannel!.config![`direct-${existingUser!._id}-${agent._id}`]).toEqual({ to: 300 })
    })

    it('does not create duplicate direct channel if participant rejoins', async () => {
      await createConversation('Meeting with Rejoining Participant')
      conversation.enableDMs = ['agents']
      const agent = new Agent({
        agentType: 'test',
        conversation
      })
      await agent.save()
      conversation.agents.push(agent)
      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      adapter.dmChannels = [{ direct: true, agent: agent._id }]
      await adapter.save()

      const participant = {
        id: 500,
        name: 'Rejoining User',
        is_host: false,
        platform: 'test'
      }

      // Mock participantJoined to return expected AdapterUser format
      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Rejoining User',
        dmConfig: { to: 500 }
      })

      // First join
      await webhookService.participantJoined(adapter, participant)

      // Get the created user and channel count
      const user = await User.findOne({ username: 'Rejoining User' })
      await conversation.populate('channels')
      const initialChannelCount = conversation.channels.length

      // Second join (participant rejoining with different ID)
      const rejoinParticipant = {
        id: 500,
        name: 'Rejoining User',
        is_host: false,
        platform: 'test'
      }

      // Mock participantJoined for rejoin
      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Rejoining User',
        dmConfig: { to: 501 }
      })

      await webhookService.participantJoined(adapter, rejoinParticipant)

      expect(mockAdapterType.participantJoined).toHaveBeenCalledTimes(2)

      // Should not create duplicate channel
      await conversation.populate('channels')
      expect(conversation.channels).toHaveLength(initialChannelCount)

      const directChannel = conversation.channels.find((c) => c.name === `direct-${user!._id}-${agent._id}`)
      expect(directChannel).toBeDefined()
      const modifiedAdapter = await Adapter.findById(adapter._id)
      const dmChannel = modifiedAdapter?.dmChannels?.find((c) => c.direct)
      expect(dmChannel!.config![`direct-${user!._id}-${agent._id}`]).toEqual({ to: 500 })
    })

    it('does not process participantJoined when adapter type returns null', async () => {
      await createConversation('Meeting with Bot Participant')
      conversation.enableDMs = ['agents']

      const agent = new Agent({
        agentType: 'test',
        conversation
      })
      await agent.save()
      conversation.agents.push(agent)
      await conversation.save()

      adapter.dmChannels = [{ direct: true, agent: agent._id }]
      await adapter.save()

      const botParticipant = {
        id: 600,
        name: 'LLM Engine', // This would be filtered out by the adapter type
        is_host: false,
        platform: 'test'
      }

      // Mock participantJoined to return null (bot filtered out)
      mockAdapterType.participantJoined.mockReturnValue(null)

      await webhookService.participantJoined(adapter, botParticipant)

      expect(mockAdapterType.participantJoined).toHaveBeenCalledWith(botParticipant)

      // Should not create user for bot
      const botUser = await User.findOne({ username: 'LLM Engine' })
      expect(botUser).toBeNull()

      // Should not create direct channel for bot
      await conversation.populate('channels')
      const directChannel = conversation.channels.find((c) => c.name.includes('direct-'))
      expect(directChannel).toBeUndefined()
    })
  })
})
