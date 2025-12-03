import mongoose from 'mongoose'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { insertTopics, newPublicTopic } from '../fixtures/topic.fixture.js'
import conversationService from '../../src/services/conversation.service.js'
import { Agent, Adapter } from '../../src/models/index.js'
import ApiError from '../../src/utils/ApiError.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { supportedModels } from '../../src/agents/helpers/getModelChat.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import { setAdapterTypes } from '../../src/models/adapter.model.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'

setupIntTest()
const topicOne = newPublicTopic()

const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockInitialize = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockAdapterStart = jest.fn()
const mockAdapterStop = jest.fn()
const mockGetUniqueKeys = jest.fn()
const testAdapterTypes = {
  zoom: {
    start: mockAdapterStart,
    stop: mockAdapterStop,
    getUniqueKeys: mockGetUniqueKeys
  }
}

const testAgentTypeSpecification = {
  eventAssistant: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Agent',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessage: 2 } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    useTranscriptRAGCollection: true
  },
  backChannelInsights: {
    initialize: mockInitialize,
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Manual Test Agent',
    description: 'A manually activated test agent with no triggers',
    maxTokens: 2000,
    defaultTriggers: undefined,
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    useTranscriptRAGCollection: true
  },
  backChannelMetrics: {
    initialize: mockInitialize,
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Manual Test Agent',
    description: 'A manually activated test agent with no triggers',
    maxTokens: 2000,
    defaultTriggers: undefined,
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

describe('Conversation service methods', () => {
  beforeAll(() => {
    setAgentTypes(testAgentTypeSpecification)
    setAdapterTypes(testAdapterTypes)
  })

  beforeEach(async () => {
    jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue()
    mockGetUniqueKeys.mockReturnValue([])
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
    setAdapterTypes(defaultAdapterTypes)
  })

  afterEach(async () => {
    jest.clearAllMocks()
  })

  describe('createConversationFromType()', () => {
    beforeEach(async () => {
      await insertUsers([registeredUser])
      await insertTopics([topicOne])
    })

    describe('Event Assistant', () => {
      test('should create conversation with required properties', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event Assistant',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789?pwd=12345',
            llmModel: supportedModels[1]
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        expect(conversation).toBeDefined()
        expect(conversation.name).toBe('Test Event Assistant')
        expect(conversation.owner).toEqual(registeredUser._id)
        expect(conversation.topic._id?.toString()).toEqual(topicOne._id.toString())
        expect(conversation.platforms).toEqual(['zoom'])
        expect(conversation.conversationType).toBe('eventAssistant')

        // Verify agents were created
        const agents = await Agent.find({ conversation: conversation._id })
        expect(agents).toHaveLength(1)
        expect(agents[0].agentType).toBe('eventAssistant')
        expect(agents[0].llmModel).toBe(supportedModels[1].llmModel)
        expect(agents[0].llmPlatform).toBe(supportedModels[1].llmPlatform)

        // Verify adapter was created with resolved properties
        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters).toHaveLength(1)
        expect(adapters[0].type).toBe('zoom')
        expect(adapters[0].config.meetingUrl).toBe('https://zoom.us/j/123456789?pwd=12345')

        // Verify channels were created
        expect(conversation.channels).toHaveLength(1)
        expect(conversation.channels[0].name).toBe('transcript')
      })

      test('should create conversation with only validation keys specified', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event Assistant',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789?pwd=12345',
            llmModel: { llmModel: supportedModels[1].llmModel, llmPlatform: supportedModels[1].llmPlatform }
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        expect(conversation).toBeDefined()
        expect(conversation.name).toBe('Test Event Assistant')
        expect(conversation.owner).toEqual(registeredUser._id)
        expect(conversation.topic._id?.toString()).toEqual(topicOne._id.toString())
        expect(conversation.platforms).toEqual(['zoom'])
        expect(conversation.conversationType).toBe('eventAssistant')

        // Verify agents were created
        const agents = await Agent.find({ conversation: conversation._id })
        expect(agents).toHaveLength(1)
        expect(agents[0].agentType).toBe('eventAssistant')
        expect(agents[0].llmModel).toBe(supportedModels[1].llmModel)
        expect(agents[0].llmPlatform).toBe(supportedModels[1].llmPlatform)

        // Verify adapter was created with resolved properties
        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters).toHaveLength(1)
        expect(adapters[0].type).toBe('zoom')
        expect(adapters[0].config.meetingUrl).toBe('https://zoom.us/j/123456789?pwd=12345')

        // Verify channels were created
        expect(conversation.channels).toHaveLength(1)
        expect(conversation.channels[0].name).toBe('transcript')
      })

      test('should use default botName when not provided', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].config.botName).toBe('Ask Privately')
      })

      test('should use custom botName when provided', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789',
            botName: 'Custom Bot Name'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].config.botName).toBe('Custom Bot Name')
      })

      test('should throw error when required zoomMeetingUrl is missing', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {}
        }

        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toThrow(ApiError)
        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST,
          message: "Required property 'zoomMeetingUrl' is missing"
        })
      })

      test('should use default adapter config when specified platform is not in adapter mapping', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['nextspace'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].type).toBe('zoom')
        expect(adapters[0].audioChannels).toBeDefined()
        expect(adapters[0].dmChannels).toHaveLength(0)
      })

      test('should create conversation with scheduledTime', async () => {
        const scheduledTime = new Date(Date.now() + 3600000) // 1 hour from now

        const params = {
          type: 'eventAssistant',
          name: 'Scheduled Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          },
          scheduledTime
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        expect(conversation.scheduledTime).toEqual(scheduledTime)
        expect(conversation.active).toBe(false) // Should not auto-start when scheduled
      })
      test('should create conversation with metadata', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Scheduled Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          },
          description: 'An event about something',
          moderators: [{ name: 'Joe Moderator', bio: 'Moderates' }],
          presenters: [
            { name: 'Sam Speaker', bio: 'Speaks' },
            { name: 'Jim Speaker', bio: 'Also Speaks' }
          ]
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        expect(conversation.description).toEqual(params.description)
        expect(conversation.moderators).toHaveLength(1)
        expect(conversation.moderators![0]).toMatchObject(params.moderators[0])
        expect(conversation.presenters).toHaveLength(2)
        expect(conversation.presenters![0]).toMatchObject(params.presenters[0])
        expect(conversation.presenters![1]).toMatchObject(params.presenters[1])
      })
      test('should not set llmModel on agents when optional property is omitted', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event Without LLM',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
            // llmModel intentionally omitted
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        expect(agents).toHaveLength(1)
        expect(agents[0].agentType).toBe('eventAssistant')
        // These should be undefined so underlying agent defaults are used
        expect(agents[0].llmModel).toBe('gpt-4o-mini') // the agent's default
        expect(agents[0].llmPlatform).toBe('openai')
      })
    })

    describe('Back Channel', () => {
      test('should create conversation with multiple agents', async () => {
        const params = {
          type: 'backChannel',
          name: 'Test Back Channel',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/987654321',
            llmModel: supportedModels[1]
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        expect(conversation).toBeDefined()
        expect(conversation.name).toBe('Test Back Channel')

        // Verify both agents were created
        const agents = await Agent.find({ conversation: conversation._id })
        expect(agents).toHaveLength(2)

        const agentTypes = agents.map((a) => a.agentType).sort()
        expect(agentTypes).toEqual(['backChannelInsights', 'backChannelMetrics'])

        // Verify both agents have correct LLM config
        agents.forEach((agent) => {
          expect(agent.llmModel).toBe(supportedModels[1].llmModel)
          expect(agent.llmPlatform).toBe(supportedModels[1].llmPlatform)
        })

        // Verify channels were created
        expect(conversation.channels).toHaveLength(3)
        const channelNames = conversation.channels.map((c) => c.name).sort()
        expect(channelNames).toEqual(['moderator', 'participant', 'transcript'])
      })

      test('should use default botName for back channel', async () => {
        const params = {
          type: 'backChannel',
          name: 'Test Back Channel',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/987654321'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].config.botName).toBe('Suggest to Speaker')
      })

      test('should configure adapter with multiple channel types', async () => {
        const params = {
          type: 'backChannel',
          name: 'Test Back Channel',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/987654321'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].dmChannels).toBeDefined()
        expect(adapters[0].chatChannels).toBeDefined()
        expect(adapters[0].dmChannels).toHaveLength(2)
        expect(adapters[0].chatChannels).toHaveLength(1)
      })

      test('should use default adapter for non-zoom platform', async () => {
        const params = {
          type: 'backChannel',
          name: 'Test Back Channel',
          platforms: ['nextspace'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/987654321'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].type).toBe('zoom')
        expect(adapters[0].audioChannels).toBeDefined()
        expect(adapters[0].chatChannels).toHaveLength(0)
        expect(adapters[0].dmChannels).toHaveLength(0)
      })
    })

    describe('Common validation', () => {
      test('should throw error for invalid topic ID', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: new mongoose.Types.ObjectId().toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          }
        }

        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toThrow(ApiError)
        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST,
          message: 'No such topic'
        })
      })

      test('should throw error for invalid conversation type', async () => {
        const params = {
          type: 'invalidType',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: new mongoose.Types.ObjectId().toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          }
        }

        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toThrow(ApiError)
        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toMatchObject({
          statusCode: httpStatus.NOT_FOUND,
          message: 'Conversation type invalidType not found'
        })
      })

      test('should validate enum property values', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789',
            llmModel: { llmPlatform: 'invalid', llmModel: 'fake' }
          }
        }

        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toThrow(ApiError)
        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST
        })
      })

      test('should throw error if missing enum validation keys', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789',
            llmModel: { name: 'gpt-4o-mini' }
          }
        }

        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toThrow(ApiError)
        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST
        })
      })

      test('should not throw error if extra enum keys', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789',
            llmModel: { name: 'gpt-4o-mini', llmPlatform: 'openai', llmModel: 'gpt-4o-mini' }
          }
        }

        await conversationService.createConversationFromType(params, registeredUser)
      })

      test('should throw error for unsupported platform', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['unsupported-platform', 'zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          }
        }

        await expect(conversationService.createConversationFromType(params, registeredUser)).rejects.toMatchObject({
          statusCode: httpStatus.NOT_FOUND,
          message: 'Invalid platform(s): unsupported-platform'
        })
      })

      test('should handle property reference resolution', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789',
            botName: 'My Custom Bot'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters[0].config.meetingUrl).toBe('https://zoom.us/j/123456789')
        expect(adapters[0].config.botName).toBe('My Custom Bot')
      })
    })
  })
})
