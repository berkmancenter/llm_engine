import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Conversation, Channel, User, Agent, ConversationMembership } from '../../src/models/index.js'
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
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'

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
    defaultLLMPlatform,
    defaultLLMModel
  }
}

// Create mock adapter type
const mockAdapterType = {
  receiveMessage: jest.fn(),
  participantJoined: jest.fn(),
  participantLeft: jest.fn(),
  participantUpdated: jest.fn()
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
      role: 'participant',
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
    adapter.participantLeft = mockAdapterType.participantLeft
    adapter.participantUpdated = mockAdapterType.participantUpdated

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

    it('creates new user with schema default preferences (true) when no defaultPreferences provided', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('Meeting with Default Preferences')

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Default Prefs User' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const newUser = await User.findOne({ username: 'Default Prefs User' })
      expect(newUser!.preferences!.visualResponse).toBe(true)
      expect(newUser!.preferences!.jargonClarification).toBe(true)
    })

    it('creates new user with adapter-supplied defaultPreferences when provided', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('Meeting with Zoom-like Preferences')

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: {
            username: 'Zoom Prefs User',
            defaultPreferences: { visualResponse: false, jargonClarification: false }
          },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const newUser = await User.findOne({ username: 'Zoom Prefs User' })
      expect(newUser!.preferences!.visualResponse).toBe(false)
      expect(newUser!.preferences!.jargonClarification).toBe(false)
    })

    it('does not override preferences of an existing user on subsequent messages', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('Meeting with Existing User Preferences')

      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()

      const existingUser = await User.create({
        username: 'Returning User',
        pseudonyms: [{ token: 'some-token', pseudonym: 'Snappy Salmon', active: true }],
        preferences: { visualResponse: true, jargonClarification: true }
      })

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: {
            username: 'Returning User',
            defaultPreferences: { visualResponse: false, jargonClarification: false }
          },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello again!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const user = await User.findById(existingUser._id)
      expect(user!.preferences!.visualResponse).toBe(true)
      expect(user!.preferences!.jargonClarification).toBe(true)
    })

    it('does not create direct channels when adapter has no chat or DM channels configured', async () => {
      const broadcastMsgSpy = jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()

      await createConversation('Zoom-only Meeting')

      // Enable DMs for agents
      conversation.enableDMs = ['agents']
      const agent = new Agent({
        agentType: 'test',
        conversation
      })
      await agent.save()
      conversation.agents.push(agent)

      const channel = await Channel.create({ name: 'transcript' })
      conversation.channels.push(channel)
      await conversation.save()

      // Configure adapter with NO chat or DM channels (Zoom-only for transcription)
      adapter.audioChannels = [{ name: 'transcript' }]
      adapter.chatChannels = []
      adapter.dmChannels = []
      await adapter.save()

      const transcriptMessage = {
        data: {
          data: {
            words: [
              {
                text: 'Hello from Zoom participant',
                end_timestamp: {
                  absolute: '2025-05-16T19:32:54.522382Z'
                }
              }
            ],
            participant: {
              id: 888,
              name: 'Zoom User',
              is_host: false,
              platform: 'zoom'
            }
          }
        },
        event: 'transcript.data'
      }

      // Mock receiveMessage to return a transcript message
      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'Zoom User', pseudonym: null },
          channels: [{ name: 'transcript', direct: false }],
          message: 'Hello from Zoom participant',
          source: 'test',
          messageType: 'text',
          createdAt: new Date('2025-05-16T19:32:54.522382Z')
        }
      ])

      await webhookService.receiveMessage(adapter, transcriptMessage)

      expect(mockAdapterType.receiveMessage).toHaveBeenCalledWith(transcriptMessage)
      expect(broadcastMsgSpy).toHaveBeenCalledTimes(1)

      // Verify user was created
      const newUser = await User.findOne({ username: 'Zoom User' })
      expect(newUser).toBeDefined()
      expect(newUser!.pseudonyms).toHaveLength(1)

      // Verify that joinConversation was NOT called (no direct channels created)
      await conversation.populate('channels')
      const directChannels = conversation.channels.filter((c) => c.name.includes('direct-'))
      expect(directChannels).toHaveLength(0)
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

    it('stores dmConfig on users channel when host joins and users is "hosts"', async () => {
      await createConversation('Meeting with Host DMs')
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'hosts' }]
      await adapter.save()

      const participant = { id: 700, name: 'Host User', is_host: true, platform: 'test' }

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Host User',
        dmConfig: { to: 700 },
        isHost: true
      })

      await webhookService.participantJoined(adapter, participant)

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config!['Host User']).toEqual({ to: 700 })
    })

    it('does not store dmConfig on users channel when non-host joins and users is "hosts"', async () => {
      await createConversation('Meeting with Non-Host')
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'hosts' }]
      await adapter.save()

      const participant = { id: 701, name: 'Regular User', is_host: false, platform: 'test' }

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Regular User',
        dmConfig: { to: 701 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, participant)

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config?.['Regular User']).toBeUndefined()
    })

    it('stores dmConfig on users channel when username matches comma-separated list', async () => {
      await createConversation('Meeting with Named Moderators')
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'Alice Smith, Bob Jones' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Alice Smith',
        dmConfig: { to: 702 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, { id: 702, name: 'Alice Smith', is_host: false, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config!['Alice Smith']).toEqual({ to: 702 })
    })

    it('does not store dmConfig on users channel when username is not in comma-separated list', async () => {
      await createConversation('Meeting with Named Moderators Exclusion')
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'Alice Smith, Bob Jones' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Carol Williams',
        dmConfig: { to: 703 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, { id: 703, name: 'Carol Williams', is_host: false, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config?.['Carol Williams']).toBeUndefined()
    })

    it('does not duplicate dmConfig on users channel when same host rejoins', async () => {
      await createConversation('Meeting with Rejoining Host')
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'hosts' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Rejoining Host',
        dmConfig: { to: 704 },
        isHost: true
      })

      await webhookService.participantJoined(adapter, { id: 704, name: 'Rejoining Host', is_host: true, platform: 'test' })
      await webhookService.participantJoined(adapter, { id: 704, name: 'Rejoining Host', is_host: true, platform: 'test' })

      expect(mockAdapterType.participantJoined).toHaveBeenCalledTimes(2)

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(Object.keys(moderatorChannel!.config!)).toHaveLength(1)
      expect(moderatorChannel!.config!['Rejoining Host']).toEqual({ to: 704 })
    })

    it('stores dmConfig on users channel when participant fuzzy matches a moderator name and users is "moderators"', async () => {
      await createConversation('Meeting with Moderator DMs')
      conversation.moderators = [{ name: 'Alice Smith' }]
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Alice Smith',
        dmConfig: { to: 710 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, { id: 710, name: 'Alice Smith', is_host: false, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config!['Alice Smith']).toEqual({ to: 710 })
    })

    it('stores dmConfig when participant fuzzy matches moderator alternateName and users is "moderators"', async () => {
      await createConversation('Meeting with Moderator Alternate Name')
      conversation.moderators = [{ name: 'Alice Smith', alternateName: 'Dr. Alice' }]
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Dr. Alice',
        dmConfig: { to: 711 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, { id: 711, name: 'Dr. Alice', is_host: false, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config!['Dr. Alice']).toEqual({ to: 711 })
    })

    it('does not store dmConfig when participant does not match any moderator and users is "moderators"', async () => {
      await createConversation('Meeting with Moderator Exclusion')
      conversation.moderators = [{ name: 'Alice Smith' }]
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Carol Williams',
        dmConfig: { to: 712 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, { id: 712, name: 'Carol Williams', is_host: false, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config?.['Carol Williams']).toBeUndefined()
    })

    it('falls back to host targeting when users is "moderators" and no moderators are defined', async () => {
      await createConversation('Meeting with Moderators Fallback to Host')
      conversation.moderators = []
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Host User',
        dmConfig: { to: 713 },
        isHost: true
      })

      await webhookService.participantJoined(adapter, { id: 713, name: 'Host User', is_host: true, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config!['Host User']).toEqual({ to: 713 })
    })

    it('does not store dmConfig for non-host when users is "moderators" and no moderators are defined', async () => {
      await createConversation('Meeting with Moderators Fallback Non-Host')
      conversation.moderators = []
      conversation.enableDMs = ['agents']
      await conversation.save()

      adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
      await adapter.save()

      mockAdapterType.participantJoined.mockReturnValue({
        username: 'Regular User',
        dmConfig: { to: 714 },
        isHost: false
      })

      await webhookService.participantJoined(adapter, { id: 714, name: 'Regular User', is_host: false, platform: 'test' })

      const modifiedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config?.['Regular User']).toBeUndefined()
    })

    describe('participantUpdated', () => {
      it('adds participant to moderator channel when they become host and no moderators are defined', async () => {
        await createConversation('Meeting with Host Promotion')
        conversation.moderators = []
        conversation.enableDMs = ['agents']
        await conversation.save()

        adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
        await adapter.save()

        // Participant joins as non-host — not added to moderator channel
        mockAdapterType.participantJoined.mockReturnValue({
          username: 'Future Host',
          dmConfig: { to: 720 },
          isHost: false
        })
        await webhookService.participantJoined(adapter, { id: 720, name: 'Future Host', is_host: false, platform: 'test' })

        let modifiedAdapter = await Adapter.findById(adapter._id)
        expect(modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')?.config?.['Future Host']).toBeUndefined()

        // Host status changes — now added to moderator channel
        mockAdapterType.participantUpdated.mockReturnValue({
          username: 'Future Host',
          dmConfig: { to: 720 },
          isHost: true
        })
        await webhookService.participantUpdated(adapter, { id: 720, name: 'Future Host', is_host: true, platform: 'test' })

        modifiedAdapter = await Adapter.findById(adapter._id)
        expect(modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')?.config?.['Future Host']).toEqual({
          to: 720
        })
      })

      it('adds participant to moderator channel when they rename to match a moderator', async () => {
        await createConversation('Meeting with Rename to Moderator')
        conversation.moderators = [{ name: 'Alice Smith' }]
        conversation.enableDMs = ['agents']
        await conversation.save()

        adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
        await adapter.save()

        // Participant joins with a non-matching name
        mockAdapterType.participantJoined.mockReturnValue({
          username: 'Unknown',
          dmConfig: { to: 721 },
          isHost: false
        })
        await webhookService.participantJoined(adapter, { id: 721, name: 'Unknown', is_host: false, platform: 'test' })

        let modifiedAdapter = await Adapter.findById(adapter._id)
        expect(modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')?.config?.Unknown).toBeUndefined()

        // Participant renames to match moderator
        mockAdapterType.participantUpdated.mockReturnValue({
          username: 'Alice Smith',
          dmConfig: { to: 721 },
          isHost: false
        })
        await webhookService.participantUpdated(adapter, { id: 721, name: 'Alice Smith', is_host: false, platform: 'test' })

        modifiedAdapter = await Adapter.findById(adapter._id)
        expect(modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')?.config?.['Alice Smith']).toEqual({
          to: 721
        })
      })

      it('does not add participant to moderator channel when update does not match criteria', async () => {
        await createConversation('Meeting with Non-Matching Update')
        conversation.moderators = [{ name: 'Alice Smith' }]
        conversation.enableDMs = ['agents']
        await conversation.save()

        adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
        await adapter.save()

        mockAdapterType.participantUpdated.mockReturnValue({
          username: 'Carol Williams',
          dmConfig: { to: 722 },
          isHost: false
        })
        await webhookService.participantUpdated(adapter, {
          id: 722,
          name: 'Carol Williams',
          is_host: false,
          platform: 'test'
        })

        const modifiedAdapter = await Adapter.findById(adapter._id)
        expect(modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')?.config?.['Carol Williams']).toBeUndefined()
      })

      it('does not process participantUpdated when adapter type returns null', async () => {
        await createConversation('Meeting with Bot Update')
        conversation.enableDMs = ['agents']
        await conversation.save()

        adapter.dmChannels = [{ name: 'moderator', direction: Direction.OUTGOING, users: 'moderators' }]
        await adapter.save()

        mockAdapterType.participantUpdated.mockReturnValue(null)
        await webhookService.participantUpdated(adapter, { id: 723, name: 'LLM Engine', is_host: true, platform: 'test' })

        const modifiedAdapter = await Adapter.findById(adapter._id)
        expect(modifiedAdapter?.dmChannels?.find((c) => c.name === 'moderator')?.config).toBeUndefined()
      })
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

  describe('participantLeft', () => {
    it('does nothing when adapter type returns null (bot left)', async () => {
      await createConversation('Meeting where Bot Left')
      conversation.enableDMs = ['agents']
      await conversation.save()

      mockAdapterType.participantLeft.mockReturnValue(null)

      await webhookService.participantLeft(adapter, { id: 999, name: 'LLM Engine', is_host: false })

      expect(mockAdapterType.participantLeft).toHaveBeenCalled()
      // No channels should exist
      await conversation.populate('channels')
      expect(conversation.channels.filter((c) => c.name?.startsWith('direct-'))).toHaveLength(0)
    })

    it('does nothing when user is not found in the database', async () => {
      await createConversation('Meeting with Unknown Leaver')
      conversation.enableDMs = ['agents']
      await conversation.save()

      mockAdapterType.participantLeft.mockReturnValue({ username: 'Ghost User' })

      // Ghost User was never created in the DB
      await webhookService.participantLeft(adapter, { id: 1, name: 'Ghost User', is_host: false })

      expect(mockAdapterType.participantLeft).toHaveBeenCalled()
      const ghostUser = await User.findOne({ username: 'Ghost User' })
      expect(ghostUser).toBeNull()
    })

    it('cleans up adapter dmChannels config when participant leaves', async () => {
      await createConversation('Meeting with Leaving Participant')
      conversation.enableDMs = ['agents']

      const agent = new Agent({ agentType: 'test', conversation })
      await agent.save()
      conversation.agents.push(agent)
      await conversation.save()

      const leavingUser = await User.create({
        username: 'Leaving User',
        pseudonyms: [{ token: 'leave-token', pseudonym: 'Leaving Pseudonym', active: true }]
      })
      const directChannelName = `direct-${leavingUser._id}-${agent._id}`

      adapter.dmChannels = [{ direct: true, agent: agent._id, config: { [directChannelName]: { to: 200 } } }]
      await adapter.save()

      mockAdapterType.participantLeft.mockReturnValue({ username: 'Leaving User' })

      await webhookService.participantLeft(adapter, { id: 200, name: 'Leaving User', is_host: false })

      const updatedAdapter = await Adapter.findById(adapter._id)
      const dmChannel = updatedAdapter!.dmChannels!.find((c) => c.direct)
      expect(dmChannel!.config?.[directChannelName]).toBeUndefined()
    })

    it('removes username-keyed dmChannel config entry when participant leaves', async () => {
      await createConversation('Meeting with Named Moderator Leaving')
      conversation.enableDMs = ['agents']
      await conversation.save()

      await User.create({
        username: 'Host User',
        pseudonyms: [{ token: 'host-token', pseudonym: 'Host Pseudonym', active: true }]
      })

      adapter.dmChannels = [{ name: 'moderator', users: 'hosts', config: { 'Host User': { to: 700 } } }]
      await adapter.save()

      mockAdapterType.participantLeft.mockReturnValue({ username: 'Host User' })

      await webhookService.participantLeft(adapter, { id: 700, name: 'Host User', is_host: true })

      const updatedAdapter = await Adapter.findById(adapter._id)
      const moderatorChannel = updatedAdapter!.dmChannels!.find((c) => c.name === 'moderator')
      expect(moderatorChannel!.config?.['Host User']).toBeUndefined()
    })

    it('leaves unrelated channels and other users dmConfig intact', async () => {
      await createConversation('Meeting with Multiple Participants Leaving')
      conversation.enableDMs = ['agents']

      const agent = new Agent({ agentType: 'test', conversation })
      await agent.save()
      conversation.agents.push(agent)
      await conversation.save()

      const leavingUser = await User.create({
        username: 'Participant A',
        pseudonyms: [{ token: 'token-a', pseudonym: 'Pseudonym A', active: true }]
      })
      const stayingUser = await User.create({
        username: 'Participant B',
        pseudonyms: [{ token: 'token-b', pseudonym: 'Pseudonym B', active: true }]
      })

      const leavingChannelName = `direct-${leavingUser._id}-${agent._id}`
      const stayingChannelName = `direct-${stayingUser._id}-${agent._id}`
      const groupChannel = await Channel.create({ name: 'participant' })
      const leavingChannel = await Channel.create({
        name: leavingChannelName,
        direct: true,
        participants: [leavingUser, agent]
      })
      const stayingChannel = await Channel.create({
        name: stayingChannelName,
        direct: true,
        participants: [stayingUser, agent]
      })
      conversation.channels.push(groupChannel, leavingChannel, stayingChannel)
      await conversation.save()

      adapter.dmChannels = [
        {
          direct: true,
          agent: agent._id,
          config: {
            [leavingChannelName]: { to: 100 },
            [stayingChannelName]: { to: 200 }
          }
        }
      ]
      await adapter.save()

      mockAdapterType.participantLeft.mockReturnValue({ username: 'Participant A' })
      await webhookService.participantLeft(adapter, { id: 100, name: 'Participant A', is_host: false })

      // All channel documents are preserved
      expect(await Channel.findById(leavingChannel._id)).not.toBeNull()
      expect(await Channel.findById(stayingChannel._id)).not.toBeNull()
      expect(await Channel.findById(groupChannel._id)).not.toBeNull()

      // Only the leaving user's dmConfig entry is removed
      const updatedAdapter = await Adapter.findById(adapter._id)
      const dmChannel = updatedAdapter!.dmChannels!.find((c) => c.direct)
      expect(dmChannel!.config?.[leavingChannelName]).toBeUndefined()
      expect(dmChannel!.config?.[stayingChannelName]).toEqual({ to: 200 })
    })
  })

  describe('getOrCreateUser — externalId membership fallback', () => {
    async function setupChannel() {
      const channel = await Channel.create({ name: 'participant' })
      conversation.channels.push(channel)
      await conversation.save()
    }

    it('reuses existing user via membership userAccount when username lookup misses', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('externalId userAccount fallback')
      await setupChannel()

      const existingUser = await User.create({
        username: 'test-EXT_123',
        email: 'linked@example.com',
        pseudonyms: [{ token: 'tok1', pseudonym: 'Linked User', active: true }]
      })
      await ConversationMembership.create({
        conversation: conversation._id,
        email: 'linked@example.com',
        name: 'Linked User',
        externalIds: { test: 'EXT_123' },
        userAccount: existingUser._id
      })

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'test-EXT_123', pseudonym: 'EXT_123', externalId: 'EXT_123' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const users = await User.find({ email: 'linked@example.com' })
      expect(users).toHaveLength(1)
      expect(users[0]._id.toString()).toBe(existingUser._id.toString())
    })

    it('finds user by email when membership has email but no userAccount', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('externalId email fallback')
      await setupChannel()

      await User.create({
        username: 'member@example.com',
        email: 'member@example.com',
        pseudonyms: [{ token: 'tok2', pseudonym: 'Member User', active: true }]
      })
      await ConversationMembership.create({
        conversation: conversation._id,
        email: 'member@example.com',
        name: 'Member User',
        externalIds: { test: 'EXT_456' }
      })

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'test-EXT_456', pseudonym: 'EXT_456', externalId: 'EXT_456' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const users = await User.find({ email: 'member@example.com' })
      expect(users).toHaveLength(1)
      expect(users[0].email).toBe('member@example.com')
    })

    it('creates user with email as username when membership has email but no account exists', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('externalId create by email')
      await setupChannel()

      await ConversationMembership.create({
        conversation: conversation._id,
        email: 'newmember@example.com',
        name: 'New Member',
        externalIds: { test: 'EXT_789' }
      })

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'test-EXT_789', pseudonym: 'EXT_789', externalId: 'EXT_789' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const createdUser = await User.findOne({ username: 'newmember@example.com' })
      expect(createdUser).toBeDefined()
      expect(createdUser!.email).toBe('newmember@example.com')

      const adapterKeyedUser = await User.findOne({ username: 'test-EXT_789' })
      expect(adapterKeyedUser).toBeNull()
    })

    it('falls back to adapter-keyed username when no membership exists for the externalId', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('externalId no membership fallback')
      await setupChannel()

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'test-UNKNOWN', pseudonym: 'UNKNOWN', externalId: 'UNKNOWN' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const createdUser = await User.findOne({ username: 'test-UNKNOWN' })
      expect(createdUser).toBeDefined()
    })

    it('writes userAccount back to membership when user is found or created via email', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('externalId userAccount writeback')
      await setupChannel()

      const membership = await ConversationMembership.create({
        conversation: conversation._id,
        email: 'writeback@example.com',
        name: 'Writeback User',
        externalIds: { test: 'EXT_WB' }
      })

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'test-EXT_WB', pseudonym: 'EXT_WB', externalId: 'EXT_WB' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const createdUser = await User.findOne({ email: 'writeback@example.com' })
      expect(createdUser).toBeDefined()
      const updatedMembership = await ConversationMembership.findById(membership._id).lean()
      expect(updatedMembership!.userAccount!.toString()).toBe(createdUser!._id.toString())
    })

    it('sets bio and interests on User from membership when creating via email fallback', async () => {
      jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
      await createConversation('externalId bio interests')
      await setupChannel()

      await ConversationMembership.create({
        conversation: conversation._id,
        email: 'biouser@example.com',
        name: 'Bio User',
        bio: 'Loves hiking',
        interests: 'Outdoors, photography',
        externalIds: { test: 'EXT_BIO' }
      })

      mockAdapterType.receiveMessage.mockResolvedValue([
        {
          user: { username: 'test-EXT_BIO', pseudonym: 'EXT_BIO', externalId: 'EXT_BIO' },
          channels: [{ name: 'participant', direct: false }],
          message: 'Hello!',
          source: 'test'
        }
      ])

      await webhookService.receiveMessage(adapter, {})

      const createdUser = await User.findOne({ email: 'biouser@example.com' })
      expect(createdUser!.bio).toBe('Loves hiking')
      expect(createdUser!.interests).toBe('Outdoors, photography')
    })
  })
})
