import mongoose from 'mongoose'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { insertTopics, newPublicTopic, newPrivateTopic } from '../fixtures/topic.fixture.js'
import conversationService from '../../src/services/conversation.service/index.js'
import { Feature } from '../../src/types/index.types.js'
import { Agent, Adapter, Conversation, Topic } from '../../src/models/index.js'
import { setConversationTypes, resetConversationTypes, getAllConversationTypes } from '../../src/conversations/index.js'
import ApiError from '../../src/utils/ApiError.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { supportedModels, defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import { setAdapterTypes } from '../../src/models/adapter.model.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import config from '../../src/config/config.js'
import schedule from '../../src/jobs/schedule.js'
import defineJob from '../../src/jobs/define.js'
import transcript from '../../src/agents/helpers/transcript.js'
import agentDispatcher from '../../src/jobs/agentDispatcher.js'
import analyticsSources from '../../src/services/analyticsSources/index.js'

jest.setTimeout(10000)
jest.mock('agenda')
setupIntTest()
const topicOne = newPublicTopic()

const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
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
    defaultLLMModel
  },

  backChannelInsights: {
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
    defaultLLMModel
  },
  backChannelMetrics: {
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
    defaultLLMModel
  },
  eventMediator: {
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
    agentConfig: {
      mediatorMinInterval: 1,
      personality: 'sarcastic-expert'
    }
  },

  engagementAgent: {
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
    defaultLLMModel
  },
  jargonFilterAgent: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Jargon Filter Agent',
    description: 'Test jargon filter agent',
    maxTokens: 500,
    defaultTriggers: { periodic: { timerPeriod: 120 } },
    priority: 50,
    llmTemplateVars: { system: [], user: [] },
    defaultLLMTemplates: {
      system: 'You are a jargon filter agent',
      user: 'Analyze this transcript: {transcript}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  voiceAssistant: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Voice Assistant',
    description: 'Test voice assistant agent',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { channels: ['transcript'] } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are a voice assistant agent',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  moderatorNotifier: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Moderator Notifier',
    description: 'Test moderator notifier agent',
    maxTokens: 500,
    defaultTriggers: { periodic: { timerPeriod: 60 } },
    priority: 50,
    llmTemplateVars: { system: [], user: [] },
    defaultLLMTemplates: {
      system: 'You are a moderator notifier agent',
      user: 'Analyze this transcript: {transcript}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  },
  librarian: {
    respond: mockRespond,
    start: mockStart,
    stop: mockStop,
    name: 'Librarian',
    description: 'Test librarian agent',
    maxTokens: 500,
    defaultTriggers: { periodic: { timerPeriod: 120 } },
    priority: 50,
    llmTemplateVars: { system: [], user: [] },
    defaultLLMTemplates: {
      system: 'You are a librarian agent',
      user: 'Recommend readings for: {transcript}'
    },
    defaultLLMPlatform,
    defaultLLMModel
  }
}

describe('Conversation service methods', () => {
  beforeAll(() => {
    setAgentTypes(testAgentTypeSpecification)
    setAdapterTypes(testAdapterTypes)
  })

  beforeEach(async () => {
    jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue()
    jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue()
    jest.spyOn(transcript, 'deleteTranscript').mockResolvedValue()
    jest.spyOn(schedule, 'cancelBatchTranscript').mockResolvedValue()
    jest.spyOn(schedule, 'batchTranscript').mockResolvedValue()
    jest.spyOn(schedule, 'cancelPeriodicAgent').mockResolvedValue()
    jest.spyOn(schedule, 'periodicAgent').mockResolvedValue()
    jest.spyOn(schedule, 'agentResponse').mockResolvedValue()
    jest.spyOn(defineJob, 'batchTranscript').mockResolvedValue()
    jest.spyOn(defineJob, 'periodicAgent').mockResolvedValue()
    jest.spyOn(defineJob, 'agentResponse').mockResolvedValue()
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
        expect(conversation.channels).toHaveLength(5)
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
        expect(conversation.channels).toHaveLength(5)
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

      test('should persist and retrieve custom properties', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Event with Custom Properties',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789',
            customField: 'custom value',
            nestedObject: { key1: 'value1', key2: 42 },
            arrayField: ['item1', 'item2']
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        // Verify properties are set on creation
        expect(conversation.properties).toBeDefined()
        expect(conversation.properties!.customField).toBe('custom value')
        expect(conversation.properties!.nestedObject).toEqual({ key1: 'value1', key2: 42 })
        expect(conversation.properties!.arrayField).toEqual(['item1', 'item2'])

        // Retrieve the conversation and verify properties are returned
        const retrieved = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)
        expect(retrieved.properties).toBeDefined()
        expect(retrieved.properties!.customField).toBe('custom value')
        expect(retrieved.properties!.nestedObject).toEqual({ key1: 'value1', key2: 42 })
        expect(retrieved.properties!.arrayField).toEqual(['item1', 'item2'])
      })

      test('should handle empty properties object', async () => {
        const params = {
          type: 'eventAssistant',
          name: 'Event with Empty Properties',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        // Properties should be an empty object by default (or contain only non-persisted fields)
        expect(conversation.properties).toBeDefined()
        expect(typeof conversation.properties).toBe('object')

        // Retrieve and verify
        const retrieved = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)
        expect(retrieved.properties).toBeDefined()
        expect(typeof retrieved.properties).toBe('object')
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

    describe('feature agent inclusion and property resolution', () => {
      const baseParams = {
        type: 'eventAssistant',
        name: 'Test Proactive Event',
        platforms: ['zoom'],
        scheduledTime: new Date(Date.now() + 3600000)
      }

      test('should include feature agent when listed in features array', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' },
          features: [{ name: 'collectiveVoice' }]
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        expect(agents.map((a) => a.agentType)).toContain('eventMediator')
      })

      test('should exclude feature agent when not listed in features array', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' },
          features: [{ name: 'catalyst' }]
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        expect(agents.map((a) => a.agentType)).not.toContain('eventMediator')
      })

      test('should include no feature agents when features array is omitted', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        const agentTypes = agents.map((a) => a.agentType)
        expect(agentTypes).not.toContain('eventMediator')
        expect(agentTypes).not.toContain('engagementAgent')
      })

      test('should resolve $ref with "as" into nested agentConfig path', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' },
          features: [{ name: 'collectiveVoice', config: { minContributionInterval: 10 } }]
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        const mediator = agents.find((a) => a.agentType === 'eventMediator')
        expect(mediator).toBeDefined()
        expect(mediator!.agentConfig?.minInterval).toBe(10)
      })

      test('should use feature sub-property default when not provided', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' },
          features: [{ name: 'collectiveVoice' }]
          // minContributionInterval not provided — feature default is 5
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        const mediator = agents.find((a) => a.agentType === 'eventMediator')
        expect(mediator).toBeDefined()
        expect(mediator!.agentConfig?.minInterval).toBe(10)
      })

      test('should use provided feature sub-property value', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' },
          features: [{ name: 'catalyst', config: { minContributionInterval: 7 } }]
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        const engagement = agents.find((a) => a.agentType === 'engagementAgent')
        expect(engagement).toBeDefined()
        expect(engagement!.agentConfig?.minInterval).toBe(7)
      })

      test('should not set llmModel on agents when llmModel property is omitted', async () => {
        const params = {
          ...baseParams,
          topicId: topicOne._id.toString(),
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/123456789'
            // llmModel intentionally omitted
          }
        }

        const conversation = await conversationService.createConversationFromType(params, registeredUser)

        const agents = await Agent.find({ conversation: conversation._id })
        agents.forEach((agent) => {
          expect(agent.llmModel).toBe(defaultLLMModel)
          expect(agent.llmPlatform).toBe(defaultLLMPlatform)
        })
      })
    })
  })

  describe('createConversation() analytics source refs', () => {
    beforeEach(async () => {
      await insertUsers([registeredUser])
      await insertTopics([topicOne])
    })

    // scheduledTime in the future keeps the conversation from auto-starting mid-test.
    const baseParams = () => ({
      name: 'Tracked Event',
      topicId: topicOne._id.toString(),
      scheduledTime: new Date(Date.now() + 3600000)
    })

    test('stores the analytics source refs the caller opted into', async () => {
      const conversation = await conversationService.createConversation(
        { ...baseParams(), analyticsRefs: { matomo: 'dimension7' } },
        registeredUser
      )
      expect(conversation.analyticsRefs?.get('matomo')).toBe('dimension7')
    })

    test('leaves analyticsRefs unset when the caller opts into nothing', async () => {
      const conversation = await conversationService.createConversation(baseParams(), registeredUser)
      expect(conversation.analyticsRefs).toBeUndefined()
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
        type: 'eventAssistant',
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

  describe('stopConversation()', () => {
    let conversation

    beforeEach(async () => {
      await insertUsers([registeredUser])
      await insertTopics([topicOne])
      conversation = new Conversation({
        name: 'Test Stop',
        owner: registeredUser._id,
        topic: topicOne._id,
        active: true,
        agents: [],
        messages: []
      })
      await conversation.save()
    })

    test('dispatches conversationStopped event when conversation is stopped', async () => {
      const dispatchSpy = jest.spyOn(agentDispatcher, 'dispatch').mockResolvedValue(undefined)

      await conversationService.stopConversation(conversation._id.toString(), registeredUser)

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'conversationStopped', conversationId: conversation._id.toString() }),
        expect.objectContaining({ type: 'conversation', id: conversation._id.toString() })
      )
    })

    test('does not capture analytics snapshots at stop time; that is deferred to the analytics consumer off the request path', async () => {
      const snapshotSpy = jest.spyOn(analyticsSources, 'fetchAndStoreSnapshot').mockResolvedValue(undefined)
      const dispatchSpy = jest.spyOn(agentDispatcher, 'dispatch').mockResolvedValue(undefined)

      await conversationService.stopConversation(conversation._id.toString(), registeredUser)

      // The stop request must not block on Matomo's archive build. The Vibes Analyst
      // pulls the snapshot from its own dispatched job, where it can retry patiently.
      expect(snapshotSpy).not.toHaveBeenCalled()
      expect(dispatchSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('updateConversation()', () => {
    let conversation
    let topicTwo

    beforeEach(async () => {
      jest.spyOn(websocketGateway, 'broadcastConversationUpdate').mockImplementation()
      await insertUsers([registeredUser])
      topicTwo = newPublicTopic()
      await insertTopics([topicOne, topicTwo])

      conversation = await conversationService.createConversationFromType(
        {
          type: 'eventAssistant',
          name: 'Original Name',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          scheduledTime: new Date(Date.now() + 3600000),
          description: 'Original description',
          properties: {
            zoomMeetingUrl: 'https://zoom.us/j/111111111',
            botName: 'OriginalBot'
          }
        },
        registeredUser
      )
    })

    test('should save changes to event name and description', async () => {
      const result = await conversationService.updateConversation(
        { id: conversation._id.toString(), name: 'Updated Name', description: 'Updated description' },
        registeredUser
      )
      expect(result!.name).toBe('Updated Name')
      expect(result!.description).toBe('Updated description')
    })

    test('should preserve other settings when only one property is updated', async () => {
      const result = await conversationService.updateConversation(
        { id: conversation._id.toString(), properties: { zoomMeetingUrl: 'https://zoom.us/j/999999999' } },
        registeredUser
      )
      expect(result!.properties!.zoomMeetingUrl).toBe('https://zoom.us/j/999999999')
      expect(result!.properties!.botName).toBe('OriginalBot')
    })

    test('should update the Zoom meeting URL on the linked adapter', async () => {
      await conversationService.updateConversation(
        { id: conversation._id.toString(), properties: { zoomMeetingUrl: 'https://zoom.us/j/999999999' } },
        registeredUser
      )
      const adapters = await Adapter.find({ conversation: conversation._id })
      expect(adapters[0].config.meetingUrl).toBe('https://zoom.us/j/999999999')
    })

    test('should update the bot name on the linked adapter', async () => {
      await conversationService.updateConversation(
        { id: conversation._id.toString(), properties: { botName: 'NewBotName' } },
        registeredUser
      )
      const adapters = await Adapter.find({ conversation: conversation._id })
      expect(adapters[0].config.botName).toBe('NewBotName')
    })

    test('should save changes to event start and end times', async () => {
      const newStart = new Date(Date.now() + 7200000)
      const newEnd = new Date(Date.now() + 10800000)
      const result = await conversationService.updateConversation(
        { id: conversation._id.toString(), scheduledTime: newStart, scheduledEndTime: newEnd },
        registeredUser
      )
      expect(result!.scheduledTime).toEqual(newStart)
      expect(result!.scheduledEndTime).toEqual(newEnd)
    })

    test('should save changes to moderators and speakers', async () => {
      const result = await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          moderators: [{ name: 'New Moderator', bio: 'Moderates things' }],
          presenters: [{ name: 'New Speaker', bio: 'Speaks about things' }]
        },
        registeredUser
      )
      expect(result!.moderators).toHaveLength(1)
      expect(result!.moderators![0].name).toBe('New Moderator')
      expect(result!.presenters).toHaveLength(1)
      expect(result!.presenters![0].name).toBe('New Speaker')
    })

    test('should move the event to a different topic', async () => {
      const result = await conversationService.updateConversation(
        { id: conversation._id.toString(), topicId: topicTwo._id.toString() },
        registeredUser
      )
      expect(result!.topic.toString()).toBe(topicTwo._id.toString())
    })

    test('should reject an update referencing a non-existent topic', async () => {
      await expect(
        conversationService.updateConversation(
          { id: conversation._id.toString(), topicId: new mongoose.Types.ObjectId().toString() },
          registeredUser
        )
      ).rejects.toMatchObject({ statusCode: httpStatus.NOT_FOUND, message: 'Topic not found' })
    })

    test('should replace the AI agent and adapter when the conversation type changes', async () => {
      const originalAgents = await Agent.find({ conversation: conversation._id })
      const originalAdapters = await Adapter.find({ conversation: conversation._id })
      expect(originalAgents.map((a) => a.agentType)).toContain('eventAssistant')

      await conversationService.updateConversation({ id: conversation._id.toString(), type: 'backChannel' }, registeredUser)

      const newAgents = await Agent.find({ conversation: conversation._id })
      const newAdapters = await Adapter.find({ conversation: conversation._id })

      expect(newAgents.map((a) => a.agentType)).not.toContain('eventAssistant')
      expect(newAgents.map((a) => a.agentType).sort()).toEqual(['backChannelInsights', 'backChannelMetrics'])

      const originalAdapterIds = originalAdapters.map((a) => a._id.toString())
      newAdapters.forEach((a) => expect(originalAdapterIds).not.toContain(a._id.toString()))
    })

    test('should save new features to the database when updated', async () => {
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          features: [{ name: 'moderatorSupport', config: {} }]
        },
        registeredUser
      )
      const updated = await Conversation.findById(conversation._id)
      const features = updated!.features as Feature[]
      expect(features).toHaveLength(1)
      expect(features[0].name).toBe('moderatorSupport')
    })

    test('should update existing features in the database when sub-properties change', async () => {
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          features: [{ name: 'moderatorSupport', config: { minContributionInterval: 5 } }]
        },
        registeredUser
      )
      // Now update the sub-property value
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          features: [{ name: 'moderatorSupport', config: { minContributionInterval: 15 } }]
        },
        registeredUser
      )
      const updated = await Conversation.findById(conversation._id)
      const features = updated!.features as Feature[]
      expect(features).toHaveLength(1)
      expect(features[0].config?.minContributionInterval).toBe(15)
    })

    test('should clear features in the database when updated to an empty array', async () => {
      // First add a feature
      await conversationService.updateConversation(
        { id: conversation._id.toString(), features: [{ name: 'moderatorSupport', config: {} }] },
        registeredUser
      )

      // Now clear it
      await conversationService.updateConversation({ id: conversation._id.toString(), features: [] }, registeredUser)

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.features).toHaveLength(0)
    })

    test('should persist the updated conversationType when the type changes', async () => {
      await conversationService.updateConversation({ id: conversation._id.toString(), type: 'backChannel' }, registeredUser)

      const updated = await Conversation.findById(conversation._id)
      expect(updated!.conversationType).toBe('backChannel')
    })

    test('should persist alternateName for speakers and moderators in the database', async () => {
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          presenters: [{ name: 'Dr. Smith', bio: 'Researcher', alternateName: 'John Smith' }],
          moderators: [{ name: 'Ms. Jones', bio: 'Host', alternateName: 'Alice Jones' }]
        },
        registeredUser
      )
      const updated = await Conversation.findById(conversation._id)
      expect(updated!.presenters![0].alternateName).toBe('John Smith')
      expect(updated!.moderators![0].alternateName).toBe('Alice Jones')
    })

    test('should persist resources to the database when updated', async () => {
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          resources: [
            {
              title: 'Attention Is All You Need',
              url: 'https://arxiv.org/abs/1706.03762',
              authors: ['Vaswani', 'Shazeer'],
              year: '2017',
              source: 'speaker',
              category: 'required',
              participantVisible: true
            }
          ]
        },
        registeredUser
      )
      const updated = await Conversation.findById(conversation._id)
      expect(updated!.resources).toHaveLength(1)
      expect(updated!.resources![0].title).toBe('Attention Is All You Need')
      expect(updated!.resources![0].url).toBe('https://arxiv.org/abs/1706.03762')
      expect(updated!.resources![0].source).toBe('speaker')
      expect(updated!.resources![0].category).toBe('required')
    })

    test('should clear resources from the database when updated to an empty array', async () => {
      // First add a resource
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          resources: [{ title: 'A Paper', source: 'speaker', category: 'suggested' }]
        },
        registeredUser
      )
      // Then clear it
      await conversationService.updateConversation({ id: conversation._id.toString(), resources: [] }, registeredUser)
      const updated = await Conversation.findById(conversation._id)
      expect(updated!.resources).toHaveLength(0)
    })

    test('should reject updates from users who do not own the event', async () => {
      const otherUser = { _id: new mongoose.Types.ObjectId(), role: 'user' }
      await expect(
        conversationService.updateConversation({ id: conversation._id.toString(), name: 'Hacked' }, otherUser)
      ).rejects.toMatchObject({ statusCode: httpStatus.FORBIDDEN })
    })

    test('should reject updates to an event that is currently live', async () => {
      await conversation.updateOne({ active: true })
      await expect(
        conversationService.updateConversation({ id: conversation._id.toString(), name: 'New Name' }, registeredUser)
      ).rejects.toMatchObject({ statusCode: httpStatus.BAD_REQUEST, message: 'Cannot update an active conversation' })
    })

    /* Fix #1: auto-start and auto-stop jobs should be rescheduled when the event's
       scheduled times change. Before this fix, updating times had no effect on
       already-queued Agenda jobs. */
    test('should reschedule the auto-start job when scheduledTime changes', async () => {
      const cancelSpy = jest.spyOn(schedule, 'cancelAutoStartConversation').mockResolvedValue(undefined)
      const scheduleSpy = jest.spyOn(schedule, 'autoStartConversation').mockResolvedValue(undefined)

      const newStart = new Date(Date.now() + 7200000)
      await conversationService.updateConversation(
        { id: conversation._id.toString(), scheduledTime: newStart },
        registeredUser
      )

      expect(cancelSpy).toHaveBeenCalledWith(conversation._id)
      expect(scheduleSpy).toHaveBeenCalled()
    })

    test('should reschedule the auto-stop job when scheduledEndTime changes', async () => {
      const cancelSpy = jest.spyOn(schedule, 'cancelAutoStopConversation').mockResolvedValue(undefined)
      const scheduleSpy = jest.spyOn(schedule, 'autoStopConversation').mockResolvedValue(undefined)

      const newEnd = new Date(Date.now() + 10800000)
      await conversationService.updateConversation(
        { id: conversation._id.toString(), scheduledEndTime: newEnd },
        registeredUser
      )

      expect(cancelSpy).toHaveBeenCalledWith(conversation._id)
      expect(scheduleSpy).toHaveBeenCalled()
    })

    /* Fix #2: when a conversation moves to a different topic, the old topic's
       conversations list should no longer include it. Before this fix, only the
       new topic was updated. */
    test('should remove the conversation from the old topic when reassigned', async () => {
      await conversationService.updateConversation(
        { id: conversation._id.toString(), topicId: topicTwo._id.toString() },
        registeredUser
      )

      const oldTopic = await Topic.findById(topicOne._id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const oldTopicConvIds = oldTopic!.conversations.map((c: any) => c._id?.toString() ?? c.toString())
      expect(oldTopicConvIds).not.toContain(conversation._id.toString())
    })

    /* Fix #4: features with enabled: false should be saved as false, not dropped.
       Before this fix, the Joi validation schema stripped the enabled field,
       so disabled features would silently revert to their type defaults. */
    test('should persist a feature with enabled: false to the database', async () => {
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          features: [{ name: 'moderatorSupport', enabled: false, config: {} }]
        },
        registeredUser
      )

      const updated = await Conversation.findById(conversation._id)
      const features = updated!.features as Feature[]
      expect(features).toHaveLength(1)
      expect(features[0].name).toBe('moderatorSupport')
      expect(features[0].enabled).toBe(false)
    })

    /* Fix #5: switching to a conversation type that doesn't support the event's
       current platform should return a clear 400 error, not silently drop adapters. */
    test('should reject a type change when the existing platform is not supported by the new type', async () => {
      /* Register a minimal conversation type that supports no platforms, so switching
         to it from a zoom-based event should fail the platform compatibility check. */
      const zoomlessType = {
        name: 'zoomlessType',
        label: 'Zoomless Type',
        description: 'A type that does not support zoom',
        platforms: [],
        properties: [],
        features: [],
        agentTypes: []
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setConversationTypes({ ...getAllConversationTypes(), zoomlessType } as any)

      try {
        await expect(
          conversationService.updateConversation({ id: conversation._id.toString(), type: 'zoomlessType' }, registeredUser)
        ).rejects.toMatchObject({ statusCode: httpStatus.BAD_REQUEST })
      } finally {
        resetConversationTypes()
      }
    })

    /* Fix #6: a type-only update (no features field sent) should keep the event's
       existing features. Before this fix, resolveConversationType was always called
       with an empty features array, dropping any features that were already saved. */
    test('should preserve existing features when only the type changes', async () => {
      await conversationService.updateConversation(
        {
          id: conversation._id.toString(),
          features: [{ name: 'moderatorSupport', config: { minContributionInterval: 5 } }]
        },
        registeredUser
      )

      await conversationService.updateConversation({ id: conversation._id.toString(), type: 'backChannel' }, registeredUser)

      const updated = await Conversation.findById(conversation._id)
      const features = updated!.features as Feature[]
      expect(features.some((f) => f.name === 'moderatorSupport')).toBe(true)
    })

    test('should recreate the adapter with the correct config when platforms change', async () => {
      /* The beforeEach conversation uses platforms: ['zoom'], which resolves to the
         zoom-only adapter config (2 dmChannels: direct agent DM + moderator DM).
         Switching to nextspace+zoom should produce the 'nextspace,zoom' config
         (1 dmChannel: direct agent DM only — moderator DMs go through NextSpace). */
      const adapterBefore = await Adapter.findOne({ conversation: conversation._id, type: 'zoom' })
      expect(adapterBefore!.dmChannels).toHaveLength(2)

      await conversationService.updateConversation(
        { id: conversation._id.toString(), platforms: ['nextspace', 'zoom'] },
        registeredUser
      )

      const adapterAfter = await Adapter.findOne({ conversation: conversation._id, type: 'zoom' })
      /* After the fix, the adapter should be recreated with the nextspace,zoom config
         (1 dmChannel). Before the fix, the old adapter is not recreated and still has 2. */
      expect(adapterAfter!.dmChannels).toHaveLength(1)
    })

    test('should update the llmModel on all agents when the property changes', async () => {
      /* Agents inherit llmModel from conversation properties at creation time via $ref
         resolution, but updateConversation currently only writes the new llmModel into
         the conversation's properties object. The Agent documents are not updated,
         so a model change set on the edit form has no effect on running agents. */
      const newModel = supportedModels[1]

      await conversationService.updateConversation(
        { id: conversation._id.toString(), properties: { llmModel: newModel } },
        registeredUser
      )

      const agents = await Agent.find({ conversation: conversation._id })
      agents.forEach((agent) => {
        expect(agent.llmModel).toBe(newModel.llmModel)
        expect(agent.llmPlatform).toBe(newModel.llmPlatform)
      })
    })

    test('should remove the agent for a feature when that feature is disabled', async () => {
      /* Feature-gated agents are created at conversation-creation time. When a feature is
         later disabled via updateConversation, only the features array on the Conversation
         document is updated — the Agent documents are not reconciled, so the agent stays. */
      const featureConv = await conversationService.createConversationFromType(
        {
          type: 'eventAssistant',
          name: 'Feature Test Event',
          platforms: ['zoom'],
          topicId: topicOne._id.toString(),
          /* Use a different scheduledTime to avoid a uniqueness conflict with the
             beforeEach conversation (both are Zoom events). */
          scheduledTime: new Date(Date.now() + 7200000),
          properties: { zoomMeetingUrl: 'https://zoom.us/j/feature-test' },
          features: [{ name: 'collectiveVoice' }]
        },
        registeredUser
      )

      const agentsBefore = await Agent.find({ conversation: featureConv._id })
      expect(agentsBefore.map((a) => a.agentType)).toContain('eventMediator')

      await conversationService.updateConversation(
        { id: featureConv._id.toString(), features: [{ name: 'collectiveVoice', enabled: false }] },
        registeredUser
      )

      const agentsAfter = await Agent.find({ conversation: featureConv._id })
      expect(agentsAfter.map((a) => a.agentType)).not.toContain('eventMediator')
    })
  })

  describe('findByIdFull()', () => {
    let conversation

    beforeEach(async () => {
      await insertUsers([registeredUser])
      await insertTopics([topicOne])

      const params = {
        type: 'eventAssistant',
        name: 'Test Conversation',
        platforms: ['zoom'],
        topicId: topicOne._id.toString(),
        scheduledTime: new Date(Date.now() + 3600000),
        properties: {
          zoomMeetingUrl: 'https://zoom.us/j/123456789'
        }
      }
      conversation = await conversationService.createConversationFromType(params, registeredUser)
    })

    test('should return full conversation with id instead of _id, is pojo', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      expect(result).toBeDefined()
      // is pojo
      expect(result).not.toBeInstanceOf(mongoose.Document)
      expect((result as unknown as Record<string, unknown>).id).toBeDefined()
    })

    test('should return conversation with expected fields', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      expect(result.name).toBe('Test Conversation')
      expect(result.platforms).toEqual(['zoom'])
      expect(result.conversationType).toBe('eventAssistant')
    })

    test('should return populated agents', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      expect(result.agents).toBeDefined()
      expect(Array.isArray(result.agents)).toBe(true)
      expect(result.agents.length).toBeGreaterThan(0)
    })

    test('should return populated channels', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      expect(result.channels).toBeDefined()
      expect(Array.isArray(result.channels)).toBe(true)
    })

    test('should return populated adapters', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      expect(result.adapters).toBeDefined()
      expect(Array.isArray(result.adapters)).toBe(true)
    })

    test('should include followed field', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      expect(result).toHaveProperty('followed')
    })

    test('should hide channel passcode from non-owner user', async () => {
      const nonOwner = {
        _id: new mongoose.Types.ObjectId(),
        role: 'user'
      }

      const result = await conversationService.findByIdFull(conversation._id.toString(), nonOwner)

      if (result.channels && result.channels.length > 0) {
        result.channels.forEach((channel) => {
          expect(channel).not.toHaveProperty('passcode')
        })
      }
    })

    test('should show channel passcode to conversation owner', async () => {
      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)

      // Owner should get channels with passcode field present (even if null)
      expect(result.channels).toBeDefined()
    })

    test('should throw NOT_FOUND error when conversation does not exist', async () => {
      const fakeId = new mongoose.Types.ObjectId().toString()

      await expect(conversationService.findByIdFull(fakeId, registeredUser)).rejects.toThrow(ApiError)
      await expect(conversationService.findByIdFull(fakeId, registeredUser)).rejects.toMatchObject({
        statusCode: httpStatus.NOT_FOUND,
        message: `Conversation with id ${fakeId} not found`
      })
    })

    test('should show channel passcode to admin user', async () => {
      const adminUser = {
        _id: new mongoose.Types.ObjectId(),
        role: 'admin'
      }

      const result = await conversationService.findByIdFull(conversation._id.toString(), adminUser)

      expect(result).toBeDefined()
      expect(result.channels).toBeDefined()
    })

    /* Fix #3: private topic fields (like passcode) should not appear in the response.
       Before this fix, topic was populated with toObject() which bypasses the toJSON
       plugin transform, leaking fields marked private: true. */
    test('should not expose private fields from the topic', async () => {
      /* Override owner so registeredUser (the test caller) can create a conversation
         on this private topic. Private topics only allow their owner to create events. */
      const privateTopic = { ...newPrivateTopic(), owner: registeredUser._id }
      await insertTopics([privateTopic])

      const params = {
        type: 'eventAssistant',
        name: 'Private Topic Event',
        platforms: ['zoom'],
        topicId: privateTopic._id.toString(),
        /* Schedule 2 hours out so it doesn't conflict with the beforeEach conversation
           (1 hour out). The adapter service rejects two Zoom events within 10 minutes. */
        scheduledTime: new Date(Date.now() + 7200000),
        properties: {
          zoomMeetingUrl: 'https://zoom.us/j/555555555'
        }
      }
      const privateConversation = await conversationService.createConversationFromType(params, registeredUser)

      const result = await conversationService.findByIdFull(privateConversation._id.toString(), registeredUser)

      expect(result.topic).toBeDefined()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.topic as any).passcode).toBeUndefined()
    })

    test('should expose hasPdf: true and omit fileName when a resource has a PDF attached', async () => {
      /* Insert a resource with fileName directly in the DB to simulate what savePdf does.
         findByIdFull should strip fileName and expose hasPdf: true instead. */
      await Conversation.updateOne(
        { _id: conversation._id },
        {
          $push: {
            resources: {
              source: 'speaker',
              category: 'required',
              title: 'Test Paper',
              participantVisible: true,
              fileName: 'test-resource.pdf'
            }
          }
        }
      )

      const result = await conversationService.findByIdFull(conversation._id.toString(), registeredUser)
      const resource = result.resources![0] as unknown as Record<string, unknown>

      expect(resource.hasPdf).toBe(true)
      expect(resource.fileName).toBeUndefined()
    })
  })
})
