import mongoose from 'mongoose'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { insertTopics, newPublicTopic } from '../fixtures/topic.fixture.js'
import conversationService from '../../src/services/conversation.service.js'
import { Agent, Adapter } from '../../src/models/index.js'
import ApiError from '../../src/utils/ApiError.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { supportedModels, defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import { setAdapterTypes } from '../../src/models/adapter.model.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import config from '../../src/config/config.js'

jest.setTimeout(10000)
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
    defaultLLMPlatform,
    defaultLLMModel,
    useTranscriptRAGCollection: true
  },
  eventAssistantPlus: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Event Assistant Plus',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessage: 2 } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel,
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
    defaultLLMPlatform,
    defaultLLMModel,
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
    defaultLLMPlatform,
    defaultLLMModel,
    useTranscriptRAGCollection: true
  },
  eventMediator: {
    initialize: mockInitialize,
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Event Mediator Test Agent',
    description: 'Test mediator agent with agentConfig',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 85,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are a mediator agent',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel,
    useTranscriptRAGCollection: true,
    agentConfig: {
      mediatorMinInterval: 1,
      personality: 'sarcastic-expert'
    }
  },
  eventMediatorPlus: {
    initialize: mockInitialize,
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Event Mediator Test Agent',
    description: 'Test mediator agent with agentConfig',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 85,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are a mediator agent',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel,
    useTranscriptRAGCollection: true,
    agentConfig: {
      mediatorMinInterval: 1,
      personality: 'sarcastic-expert'
    }
  },
  engagementAgent: {
    initialize: mockInitialize,
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Event Engament Test Agent',
    description: 'Test engagement agent with agentConfig',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 85,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an engagement agent',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel,
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
        expect(agents[0].agentType).toBe('eventAssistant')
        expect(agents[0].llmModel).toBe(supportedModels[1].llmModel)
        expect(agents[0].llmPlatform).toBe(supportedModels[1].llmPlatform)

        // Verify adapter was created with resolved properties
        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters).toHaveLength(1)
        expect(adapters[0].type).toBe('zoom')
        expect(adapters[0].config.meetingUrl).toBe('https://zoom.us/j/123456789?pwd=12345')

        // Verify channels were created
        expect(conversation.channels).toHaveLength(3)
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

        expect(agents[0].agentType).toBe('eventAssistant')
        expect(agents[0].llmModel).toBe(supportedModels[1].llmModel)
        expect(agents[0].llmPlatform).toBe(supportedModels[1].llmPlatform)

        // Verify adapter was created with resolved properties
        const adapters = await Adapter.find({ conversation: conversation._id })
        expect(adapters).toHaveLength(1)
        expect(adapters[0].type).toBe('zoom')
        expect(adapters[0].config.meetingUrl).toBe('https://zoom.us/j/123456789?pwd=12345')

        // Verify channels were created
        expect(conversation.channels).toHaveLength(3)
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
        expect(adapters[0].config.botName).toBe(config.conversationBotName)
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
        expect(agents[0].agentType).toBe('eventAssistant')
        // These should be undefined so underlying agent defaults are used
        expect(agents[0].llmModel).toBe(defaultLLMModel) // the agent's default
        expect(agents[0].llmPlatform).toBe(defaultLLMPlatform)
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

        // Verify agents were created
        const agents = await Agent.find({ conversation: conversation._id })

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
            llmModel: { name: 'opus-4.5', llmPlatform: defaultLLMPlatform, llmModel: defaultLLMModel }
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

  describe('generateConversationReport()', () => {
    let periodicConversation
    let perMessageConversation
    let mockGenerateReport

    beforeEach(async () => {
      await insertUsers([registeredUser])
      await insertTopics([topicOne])

      // Mock reportService.generateReport
      const reportService = await import('../../src/services/report.service.js')
      mockGenerateReport = jest.spyOn(reportService.default, 'generateReport').mockResolvedValue('mock report output')

      // Use different scheduled times to prevent adapter conflicts (must be > 10 minutes apart)
      const periodicTime = new Date(Date.now() + 3600000) // 1 hour in future
      const perMessageTime = new Date(Date.now() + 7200000) // 2 hours in future (more than 10 min apart)

      // Create conversation with periodic agent (eventMediator)
      const periodicParams = {
        type: 'eventAssistantPlusProactive',
        name: 'Periodic Test Conversation',
        platforms: ['zoom'],
        topicId: topicOne._id.toString(),
        scheduledTime: periodicTime,
        properties: {
          zoomMeetingUrl: 'https://zoom.us/j/periodic123report'
        }
      }
      periodicConversation = await conversationService.createConversationFromType(periodicParams, registeredUser)

      // Create conversation with perMessage agent (eventAssistant has perMessage triggers)
      const perMessageParams = {
        type: 'eventAssistant',
        name: 'PerMessage Test Conversation',
        platforms: ['zoom'],
        topicId: topicOne._id.toString(),
        scheduledTime: perMessageTime,
        properties: {
          zoomMeetingUrl: 'https://zoom.us/j/permessage123report'
        }
      }
      perMessageConversation = await conversationService.createConversationFromType(perMessageParams, registeredUser)
    })

    afterEach(() => {
      mockGenerateReport.mockRestore()
    })

    describe('periodicResponses report', () => {
      test('should generate report for conversation with periodic agents', async () => {
        const result = await conversationService.generateConversationReport(
          periodicConversation._id.toString(),
          'periodicResponses',
          'text',
          'UTC'
        )

        expect(result).toBe('mock report output')
        expect(mockGenerateReport).toHaveBeenCalledWith(
          expect.objectContaining({ _id: periodicConversation._id }),
          'periodicResponses',
          'text',
          'UTC',
          [],
          undefined,
          {
            name: periodicConversation.name,
            description: periodicConversation.description,
            executedAt: periodicConversation.endTime || periodicConversation.startTime
          }
        )
      })

      test('should throw error if conversation has no periodic agents', async () => {
        // Create a conversation with only perMessage agents (no periodic)
        const onlyPerMessageParams = {
          name: 'Only PerMessage',
          topicId: topicOne._id.toString(),
          agentTypes: ['eventAssistant'], // only has perMessage triggers, not periodic
          scheduledTime: new Date(Date.now() + 3600000) // prevent auto-start
        }
        const onlyPerMessageConv = await conversationService.createConversation(onlyPerMessageParams, registeredUser)

        await expect(
          conversationService.generateConversationReport(onlyPerMessageConv._id.toString(), 'periodicResponses')
        ).rejects.toThrow(ApiError)
        await expect(
          conversationService.generateConversationReport(onlyPerMessageConv._id.toString(), 'periodicResponses')
        ).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST,
          message: 'Conversation has no periodic agents for periodicResponses report'
        })
      })
    })

    describe('directMessageResponses report', () => {
      test('should generate report for conversation with perMessage agents', async () => {
        const additionalChannels = ['moderator', 'participant']
        const result = await conversationService.generateConversationReport(
          perMessageConversation._id.toString(),
          'directMessageResponses',
          'text',
          'America/New_York',
          additionalChannels
        )

        expect(result).toBe('mock report output')
        expect(mockGenerateReport).toHaveBeenCalledWith(
          expect.objectContaining({ _id: perMessageConversation._id }),
          'directMessageResponses',
          'text',
          'America/New_York',
          additionalChannels,
          undefined,
          {
            name: perMessageConversation.name,
            description: perMessageConversation.description,
            executedAt: perMessageConversation.endTime || perMessageConversation.startTime
          }
        )
      })

      test('should throw error if conversation has no perMessage agents', async () => {
        // Create a conversation with only periodic agents (no perMessage)
        const onlyPeriodicParams = {
          name: 'Only Periodic',
          topicId: topicOne._id.toString(),
          agentTypes: ['eventMediator'],
          scheduledTime: new Date(Date.now() + 3600000) // prevent auto-start
        }
        const onlyPeriodicConv = await conversationService.createConversation(onlyPeriodicParams, registeredUser)

        await expect(
          conversationService.generateConversationReport(onlyPeriodicConv._id.toString(), 'directMessageResponses')
        ).rejects.toThrow(ApiError)
        await expect(
          conversationService.generateConversationReport(onlyPeriodicConv._id.toString(), 'directMessageResponses')
        ).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST,
          message: 'Conversation has no perMessage agents for this report type'
        })
      })
    })

    describe('userMetrics report', () => {
      test('should generate report for specific agent type', async () => {
        const additionalChannels = ['moderator']
        const result = await conversationService.generateConversationReport(
          perMessageConversation._id.toString(),
          'userMetrics',
          'text',
          'UTC',
          additionalChannels,
          'eventAssistant'
        )

        expect(result).toBe('mock report output')
        expect(mockGenerateReport).toHaveBeenCalledWith(
          expect.objectContaining({ _id: perMessageConversation._id }),
          'userMetrics',
          'text',
          'UTC',
          additionalChannels,
          'eventAssistant',
          {
            name: perMessageConversation.name,
            description: perMessageConversation.description,
            executedAt: perMessageConversation.endTime || perMessageConversation.startTime
          }
        )
      })

      test('should throw error if agent type not found in conversation', async () => {
        await expect(
          conversationService.generateConversationReport(
            perMessageConversation._id.toString(),
            'userMetrics',
            'text',
            'UTC',
            [],
            'nonExistentAgent'
          )
        ).rejects.toThrow(ApiError)
        await expect(
          conversationService.generateConversationReport(
            perMessageConversation._id.toString(),
            'userMetrics',
            'text',
            'UTC',
            [],
            'nonExistentAgent'
          )
        ).rejects.toMatchObject({
          statusCode: httpStatus.NOT_FOUND,
          message: "Agent 'nonExistentAgent' not found in conversation"
        })
      })

      test('should throw error if conversation has no perMessage agents', async () => {
        // Create a conversation with only periodic agents
        const onlyPeriodicParams = {
          name: 'Only Periodic UserMetrics',
          topicId: topicOne._id.toString(),
          agentTypes: ['eventMediator'],
          scheduledTime: new Date(Date.now() + 3600000) // prevent auto-start
        }
        const onlyPeriodicConv = await conversationService.createConversation(onlyPeriodicParams, registeredUser)

        await expect(
          conversationService.generateConversationReport(
            onlyPeriodicConv._id.toString(),
            'userMetrics',
            'text',
            'UTC',
            [],
            'eventMediator'
          )
        ).rejects.toThrow(ApiError)
        await expect(
          conversationService.generateConversationReport(
            onlyPeriodicConv._id.toString(),
            'userMetrics',
            'text',
            'UTC',
            [],
            'eventMediator'
          )
        ).rejects.toMatchObject({
          statusCode: httpStatus.BAD_REQUEST,
          message: 'Conversation has no perMessage agents for this report type'
        })
      })
    })

    describe('error handling', () => {
      test('should throw error if conversation not found', async () => {
        const fakeId = new mongoose.Types.ObjectId().toString()

        await expect(conversationService.generateConversationReport(fakeId, 'periodicResponses')).rejects.toThrow(ApiError)
        await expect(conversationService.generateConversationReport(fakeId, 'periodicResponses')).rejects.toMatchObject({
          statusCode: httpStatus.NOT_FOUND,
          message: 'Conversation not found'
        })
      })

      test('should use default parameters when not provided', async () => {
        await conversationService.generateConversationReport(periodicConversation._id.toString(), 'periodicResponses')

        expect(mockGenerateReport).toHaveBeenCalledWith(
          expect.anything(),
          'periodicResponses',
          'text', // default format
          'UTC', // default timezone
          [], // default additionalChannels
          undefined, // default agentType
          expect.anything()
        )
      })
    })
  })
})
