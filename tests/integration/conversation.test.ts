import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { userOneAccessToken, userTwoAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import schedule from '../../src/jobs/schedule.js'
import { Conversation, Agent, Channel, Follower, Message } from '../../src/models/index.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import defaultAdapterTypes from '../../src/adapters/index.js'
import defaultConversationTypes, { setConversationTypes } from '../../src/conversations/index.js'

import websocketGateway from '../../src/websockets/websocketGateway.js'
import {
  conversationOne,
  conversationTwo,
  conversationThree,
  conversationWithChannels,
  insertConversations,
  insertChannels,
  publicTopic,
  privateTopic,
  conversationAgentsEnabled,
  experimentalConversation
} from '../fixtures/conversation.fixture.js'

import {
  messageOne,
  messageTwo,
  messageThree,
  messageFour,
  invisibleMessage,
  insertMessages
} from '../fixtures/message.fixture.js'

import { conversationFollow, insertFollowers } from '../fixtures/follower.fixture.js'
import Adapter, { setAdapterTypes } from '../../src/models/adapter.model.js'
import defineJob from '../../src/jobs/define.js'
import { ConversationType, Direction } from '../../src/types/index.types.js'
import transcript from '../../src/agents/helpers/transcript.js'

jest.setTimeout(120000)

Error.stackTraceLimit = Infinity

const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockInitialize = jest.fn()
const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockAdapterStart = jest.fn()
const mockAdapterStop = jest.fn()
const mockGetUniqueKeys = jest.fn()

const testAgentTypeSpecification = {
  test: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    isWithinTokenLimit: mockTokenLimit,
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
  testManual: {
    initialize: mockInitialize,
    respond: mockRespond,
    isWithinTokenLimit: mockTokenLimit,
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

const testAdapterTypes = {
  slack: {
    start: mockAdapterStart,
    stop: mockAdapterStop,
    getUniqueKeys: mockGetUniqueKeys
  },
  zoom: {
    start: mockAdapterStart,
    stop: mockAdapterStop,
    getUniqueKeys: mockGetUniqueKeys
  }
}

const testConversationTypes = {
  testEventAssistant: {
    name: 'testEventAssistant',
    label: 'Test Event Assistant',
    description: 'A test event assistant conversation type',
    platforms: [{ name: 'zoom' }, { name: 'slack' }],
    properties: [
      { name: 'meetingUrl', required: true, type: 'string' },
      { name: 'botName', required: false, type: 'string', default: 'Test Bot' }
    ],
    agents: [{ name: 'test' }],
    channels: [{ name: 'transcript' }],
    enableDMs: ['agents'],
    adapters: {
      zoom: {
        type: 'zoom',
        config: {
          meetingUrl: '{{properties.meetingUrl}}',
          botName: '{{properties.botName}}'
        },
        dmChannels: [
          {
            direct: true,
            agent: 'test',
            direction: 'both'
          }
        ],
        audioChannels: [
          {
            name: 'transcript',
            direction: Direction.INCOMING
          }
        ]
      },
      slack: {
        type: 'slack',
        config: {
          webhookUrl: '{{properties.meetingUrl}}',
          botName: '{{properties.botName}}'
        },
        audioChannels: [
          {
            name: 'transcript',
            direction: Direction.INCOMING
          }
        ]
      },
      default: {
        type: 'zoom',
        config: {
          meetingUrl: '{{properties.meetingUrl}}',
          botName: '{{properties.botName}}'
        },
        audioChannels: [
          {
            name: 'transcript',
            direction: Direction.INCOMING
          }
        ]
      }
    }
  } as ConversationType,
  testMultiAgent: {
    name: 'testMultiAgent',
    label: 'Test Multi Agent',
    description: 'A test conversation type with multiple agents',
    platforms: [{ name: 'zoom' }],
    properties: [{ name: 'meetingUrl', required: true, type: 'string' }],
    agents: [{ name: 'test' }, { name: 'testManual' }],
    channels: [{ name: 'channel1' }, { name: 'channel2' }],
    enableDMs: ['agents'],
    adapters: {
      zoom: {
        type: 'zoom',
        config: {
          meetingUrl: '{{properties.meetingUrl}}'
        },
        audioChannels: [
          { name: 'channel1', direction: Direction.INCOMING },
          { name: 'channel2', direction: Direction.INCOMING }
        ]
      }
    }
  } as ConversationType
}

jest.mock('agenda')
setupIntTest()

let agentConversation
let cancelBatchTranscriptSpy
let scheduleBatchTranscriptSpy
let defineJobSpy
let newConversationSpy

describe('Conversation routes', () => {
  beforeAll(() => {
    setAgentTypes(testAgentTypeSpecification)
    setAdapterTypes(testAdapterTypes)
    setConversationTypes(testConversationTypes)
  })
  beforeEach(async () => {
    await insertUsers([userOne, userTwo])
    await insertTopics([publicTopic, privateTopic])
    await insertMessages([messageOne, messageTwo, messageThree, messageFour, invisibleMessage])
    conversationOne.messages = [messageOne]
    conversationTwo.messages = [messageTwo, messageThree]
    conversationThree.messages = [messageFour, invisibleMessage]
    experimentalConversation.messages = [messageFour, invisibleMessage]

    await insertConversations([conversationOne, conversationTwo, conversationThree, experimentalConversation])
    agentConversation = new Conversation(conversationAgentsEnabled)
    await agentConversation.save()
    cancelBatchTranscriptSpy = jest.spyOn(schedule, 'cancelBatchTranscript').mockResolvedValue()
    scheduleBatchTranscriptSpy = jest.spyOn(schedule, 'batchTranscript').mockResolvedValue()
    defineJobSpy = jest.spyOn(defineJob, 'batchTranscript').mockResolvedValue()
    newConversationSpy = jest.spyOn(websocketGateway, 'broadcastNewConversation').mockResolvedValue()
    mockGetUniqueKeys.mockReturnValue([])
  })
  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
    setAdapterTypes(defaultAdapterTypes)
    setConversationTypes(defaultConversationTypes)
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })

  describe('GET /v1/conversations/', () => {
    test('should return 200 and body should be all non-experimental conversations with message counts', async () => {
      const resp = await request(app)
        .get(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(4)

      const t1 = resp.body.find((x) => x.id === conversationOne._id.toString())
      expect(t1.messageCount).toEqual(1)

      const t2 = resp.body.find((x) => x.id === conversationTwo._id.toString())
      expect(t2.messageCount).toEqual(2)

      // count should be 1 for visible message only
      const t3 = resp.body.find((x) => x.id === conversationThree._id.toString())
      expect(t3.messageCount).toEqual(1)
    })
  })

  describe('POST /v1/conversations/', () => {
    test('should return 201 and create specified conversation agent', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Agent Conversation',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test']
        })
        .expect(httpStatus.CREATED)
      expect(newConversationSpy).toHaveBeenCalled()

      expect(resp.body.agents).toHaveLength(1)
      expect(resp.body.channels).toHaveLength(0)

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()
      expect(conversation!.name).toBe('Test Agent Conversation')
      expect(conversation!.agents).toHaveLength(1)
      expect(conversation!.channels).toHaveLength(0)
    })

    test('should return 201 and create specified channels', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Channel Conversation',
          topicId: publicTopic._id.toString(),
          enableDMs: ['agents'],
          channels: [{ name: 'channel1', passcode: 'Channel1_CoDe' }, { name: 'channel2' }]
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()
      expect(resp.body.channels).toHaveLength(2)
      expect(resp.body.channels[0].name).toBe('channel1')
      expect(resp.body.channels[0].passcode).toBe('Channel1_CoDe')

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()
      expect(conversation!.name).toBe('Test Channel Conversation')
      expect(conversation!.agents).toHaveLength(0)
      expect(conversation!.channels).toHaveLength(2)
    })

    test('should return 400 if attempting to create a direct channel in a conversation that does not allow DMs', async () => {
      await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Channel Conversation',
          topicId: publicTopic._id.toString(),
          channels: [
            { name: 'channel1', passcode: 'Channel1_CoDe', direct: true },
            { name: 'channel2', passcode: 'channel2_CODE' }
          ]
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 201 and create specified adapter', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Adapter Conversation',
          topicId: publicTopic._id.toString(),
          adapters: [{ type: 'slack' }, { type: 'zoom', config: { meetingUrl: 'http://mymeeting.com' } }]
        })
        .expect(httpStatus.CREATED)
      expect(newConversationSpy).toHaveBeenCalled()

      expect(resp.body.adapters).toHaveLength(2)

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()
      expect(conversation!.name).toBe('Test Adapter Conversation')
      expect(conversation!.adapters).toHaveLength(2)
    })

    test('non-owner fetching a conversation with channels should not see passcodes', async () => {
      const channels = await insertChannels(conversationWithChannels.channels)
      const toInsert = {
        ...conversationWithChannels,
        channels
      }
      await insertConversations([toInsert])

      const resp = await request(app)
        .get(`/v1/conversations/${conversationWithChannels._id.toString()}`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .expect(httpStatus.OK)

      expect(resp.body.channels).toHaveLength(3)
      expect(resp.body.channels[0].name).toBe('channel1')
      expect(resp.body.channels[0].passcode).toBeUndefined()
    })
    test('should return 201 and start conversation with no scheduled time', async () => {
      const transcriptSpy = jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue()
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Agent Conversation',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test']
        })
        .expect(httpStatus.CREATED)
      expect(newConversationSpy).toHaveBeenCalled()

      expect(mockStart).toHaveBeenCalled()
      expect(resp.body.startTime).toBeDefined()
      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()
      expect(conversation!.agents).toHaveLength(1)
      const modifiedAgent = conversation!.agents[0]
      expect(modifiedAgent.active).toBe(true)
      expect(cancelBatchTranscriptSpy).toHaveBeenCalledWith(conversation!._id)
      expect(defineJobSpy).toHaveBeenCalledWith(conversation!._id)
      expect(scheduleBatchTranscriptSpy).toHaveBeenCalledWith('30 seconds', { conversationId: conversation!._id })
      expect(transcriptSpy).toHaveBeenCalled()
    })
    test('should return 201 and not start conversation with scheduled time', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Agent Conversation',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test'],
          scheduledTime: '2025-03-25T16:15:00Z'
        })
        .expect(httpStatus.CREATED)
      expect(newConversationSpy).toHaveBeenCalled()

      expect(mockStart).not.toHaveBeenCalled()
      expect(resp.body.startTime).not.toBeDefined()
      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()
      expect(conversation!.scheduledTime).toEqual(new Date('2025-03-25T16:15:00Z'))
      expect(conversation!.agents).toHaveLength(1)
      const modifiedAgent = conversation!.agents[0]
      expect(modifiedAgent.active).toBe(false)
    })
    test('should call introduce on agents for each channel when creating conversation with agents and channels', async () => {
      const scheduleSpy = jest.spyOn(schedule, 'agentIntroduction').mockResolvedValue()

      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Agent and Channel Conversation',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test'],
          enableDMs: ['agents'],
          channels: [{ name: 'channel1', passcode: 'Channel1_CoDe' }, { name: 'channel2' }]
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()
      expect(resp.body.agents).toHaveLength(1)
      expect(resp.body.channels).toHaveLength(2)

      // Verify introduce was called twice (once for each channel)
      expect(scheduleSpy).toHaveBeenCalledTimes(2)
      expect(scheduleSpy).toHaveBeenCalledWith({
        agentId: new mongoose.Types.ObjectId(resp.body.agents[0].id),
        channelId: new mongoose.Types.ObjectId(resp.body.channels[0]._id)
      })
      expect(scheduleSpy).toHaveBeenCalledWith({
        agentId: new mongoose.Types.ObjectId(resp.body.agents[0].id),
        channelId: new mongoose.Types.ObjectId(resp.body.channels[1]._id)
      })
    })

    test('should not call introduce when creating conversation with channels but no agents', async () => {
      const scheduleSpy = jest.spyOn(schedule, 'agentIntroduction').mockResolvedValue()
      await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Channel Only Conversation',
          topicId: publicTopic._id.toString(),
          channels: [{ name: 'channel1', passcode: 'Channel1_CoDe' }]
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()

      // Should not call introduce when there are no agents
      expect(scheduleSpy).not.toHaveBeenCalled()
    })

    test('should not call introduce when creating conversation with agents but no channels', async () => {
      const scheduleSpy = jest.spyOn(schedule, 'agentIntroduction').mockResolvedValue()
      await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Agent Only Conversation',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test']
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()

      // Should not call introduce when there are no channels
      expect(scheduleSpy).not.toHaveBeenCalled()
    })

    test('should call introduce multiple times with multiple agents and multiple channels', async () => {
      const scheduleSpy = jest.spyOn(schedule, 'agentIntroduction').mockResolvedValue()
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Multi Agent Multi Channel Conversation',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test', 'testManual'],
          enableDMs: ['agents'],
          channels: [
            { name: 'general', passcode: 'GeneralPass' },
            { name: 'private', passcode: 'PrivatePass' }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()
      expect(resp.body.agents).toHaveLength(2)
      expect(resp.body.channels).toHaveLength(2)

      // Should call introduce 6 times (2 agents × 2 channels)
      expect(scheduleSpy).toHaveBeenCalledTimes(4)
    })
  })
  describe('POST /v1/conversations/from-type', () => {
    test('should return 201 and create conversation from type with all required fields', async () => {
      const resp = await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testEventAssistant',
          name: 'Tech Conference Q&A',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/123456789',
            botName: 'Conference Bot'
          }
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()
      expect(resp.body.name).toBe('Tech Conference Q&A')
      expect(resp.body.agents).toHaveLength(1)
      expect(resp.body.agents[0].agentType).toBe('test')
      expect(resp.body.adapters).toHaveLength(1)
      expect(resp.body.adapters[0].type).toBe('zoom')
      expect(resp.body.channels).toHaveLength(1)
      expect(resp.body.channels[0].name).toBe('transcript')

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()
      expect(conversation!.name).toBe('Tech Conference Q&A')
    })

    test('should return 404 when required type field is missing', async () => {
      await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Tech Conference Q&A',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/123456789'
          }
        })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 400 when required topicId field is missing', async () => {
      await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testEventAssistant',
          name: 'Tech Conference Q&A',
          platforms: ['zoom'],
          properties: {
            meetingUrl: 'https://zoom.us/j/123456789'
          }
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 404 when conversation type does not exist', async () => {
      await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'nonExistentType',
          name: 'Test Conversation',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {}
        })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 201 and handle scheduled conversations', async () => {
      const resp = await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testEventAssistant',
          name: 'Scheduled Conference',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/987654321'
          },
          scheduledTime: '2025-11-01T14:00:00Z'
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.scheduledTime).toBeDefined()
      expect(mockStart).not.toHaveBeenCalled()

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation!.scheduledTime).toEqual(new Date('2025-11-01T14:00:00Z'))
    })

    test('should return 201 and use default platform when platform not specified', async () => {
      const resp = await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testEventAssistant',
          name: 'Default Platform Test',
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/111111111'
          }
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)
      expect(resp.body.adapters[0].type).toBe('zoom') // Should use default
    })

    test('should return 201 and create multiple adapters for multiple platforms', async () => {
      const resp = await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testEventAssistant',
          name: 'Multi Platform Test',
          platforms: ['zoom', 'slack'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/222222222',
            botName: 'Multi Bot'
          }
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(2)
      expect(resp.body.adapters[0].type).toBe('zoom')
      expect(resp.body.adapters[1].type).toBe('slack')
    })

    test('should return 201 and apply default property values', async () => {
      const resp = await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testEventAssistant',
          name: 'Default Properties Test',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/333333333'
            // botName not provided, should use default
          }
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)
      // The botName default should have been applied in the service layer
    })

    test('should return 201 and create conversation with multiple agents', async () => {
      const resp = await request(app)
        .post(`/v1/conversations/from-type`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          type: 'testMultiAgent',
          name: 'Multi Agent Test',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/444444444'
          }
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.agents).toHaveLength(2)
      expect(resp.body.channels).toHaveLength(2)
      expect(resp.body.channels[0].name).toBe('channel1')
      expect(resp.body.channels[1].name).toBe('channel2')
    })

    test('should return 401 when no auth token provided', async () => {
      await request(app)
        .post(`/v1/conversations/from-type`)
        .send({
          type: 'testEventAssistant',
          name: 'Tech Conference Q&A',
          platforms: ['zoom'],
          topicId: publicTopic._id.toString(),
          properties: {
            meetingUrl: 'https://zoom.us/j/123456789'
          }
        })
        .expect(httpStatus.UNAUTHORIZED)
    })
  })
  describe('POST /v1/conversations/ - Adapter functionality', () => {
    test('should return 201 and create adapter with audio and chat channels', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Adapter Channels Conversation',
          topicId: publicTopic._id.toString(),
          channels: [
            { name: 'audio1', passcode: 'Audio1Pass' },
            { name: 'chat1', passcode: 'Chat1Pass' },
            { name: 'unused', passcode: 'UnusedPass' }
          ],
          adapters: [
            {
              type: 'slack',
              config: { webhookUrl: 'http://slack.webhook.com' },
              audioChannels: [{ name: 'audio1' }],
              chatChannels: [{ name: 'chat1' }]
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(newConversationSpy).toHaveBeenCalled()
      expect(resp.body.adapters).toHaveLength(1)
      expect(resp.body.channels).toHaveLength(3)

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation).toBeTruthy()

      // Verify adapter was created with correct channel references
      const adapter = await Adapter.findOne({ conversation: conversation!._id })
      expect(adapter).toBeTruthy()
      expect(adapter!.type).toBe('slack')
      expect(adapter!.audioChannels).toHaveLength(1)
      expect(adapter!.audioChannels![0].name).toEqual('audio1')
      expect(adapter!.chatChannels).toHaveLength(1)
      expect(adapter!.chatChannels![0].name).toEqual('chat1')

      await conversation!.populate('channels')
    })

    test('should return 201 and create adapter with DM channels', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Adapter DM Conversation',
          topicId: publicTopic._id.toString(),
          enableDMs: ['agents'],
          agentTypes: ['test'],
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'zoom123' },
              dmChannels: [{ agent: 'test', name: 'test-dm', direct: true }]
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)
      expect(resp.body.agents).toHaveLength(1)

      const conversation = await Conversation.findById(resp.body.id)
      const adapter = await Adapter.findOne({ conversation: conversation!._id })

      expect(adapter).toBeTruthy()
      expect(adapter!.dmChannels).toHaveLength(1)
      expect(adapter!.dmChannels![0].name).toBe('test-dm')
      expect(adapter!.dmChannels![0].direct).toBe(true)
      // Agent reference should be replaced with ObjectId
      expect(adapter!.dmChannels![0].agent).toEqual(conversation!.agents[0]._id)
    })

    test('should return 400 when adapter uses direct channels but DMs are disabled', async () => {
      await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test DM Disabled',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test'],
          // enableDMs not specified, defaults to empty array
          adapters: [
            {
              type: 'zoom',
              dmChannels: [{ agent: 'test', name: 'test-dm', direct: true }]
            }
          ]
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 when adapter references non-existent agent for DM channel', async () => {
      await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Missing Agent',
          topicId: publicTopic._id.toString(),
          enableDMs: ['agents'],
          agentTypes: ['test'],
          adapters: [
            {
              type: 'slack',
              dmChannels: [{ agent: 'non-existent-agent', name: 'missing-agent-dm', direct: true }]
            }
          ]
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 201 and create multiple adapters with overlapping channels', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Multiple Adapters',
          topicId: publicTopic._id.toString(),
          channels: [
            { name: 'shared-channel', passcode: 'SharedPass' },
            { name: 'slack-only', passcode: 'SlackPass' },
            { name: 'zoom-only', passcode: 'ZoomPass' }
          ],
          adapters: [
            {
              type: 'slack',
              audioChannels: [{ name: 'shared-channel' }, { name: 'slack-only' }]
            },
            {
              type: 'zoom',
              chatChannels: [{ name: 'shared-channel' }, { name: 'zoom-only' }]
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(2)
      expect(resp.body.channels).toHaveLength(3)

      const conversation = await Conversation.findById(resp.body.id)
      const adapters = await Adapter.find({ conversation: conversation!._id })

      expect(adapters).toHaveLength(2)

      await conversation!.populate('channels')
    })

    test('should return 201 and create adapter with mixed channel types', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Mixed Channels',
          topicId: publicTopic._id.toString(),
          enableDMs: ['agents'],
          agentTypes: ['test', 'testManual'],
          channels: [
            { name: 'audio-channel', passcode: 'AudioPass' },
            { name: 'chat-channel', passcode: 'ChatPass' }
          ],
          adapters: [
            {
              type: 'slack',
              config: { token: 'slack-token' },
              audioChannels: [{ name: 'audio-channel' }],
              chatChannels: [{ name: 'chat-channel' }],
              dmChannels: [
                { agent: 'test', name: 'test-dm', direct: true },
                { agent: 'testManual', name: 'manual-dm', direct: true }
              ]
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)
      expect(resp.body.agents).toHaveLength(2)
      expect(resp.body.channels).toHaveLength(2)

      const conversation = await Conversation.findById(resp.body.id)
      const adapter = await Adapter.findOne({ conversation: conversation!._id })

      expect(adapter).toBeTruthy()
      expect(adapter!.audioChannels).toHaveLength(1)
      expect(adapter!.audioChannels![0].name).toEqual('audio-channel')
      expect(adapter!.chatChannels).toHaveLength(1)
      expect(adapter!.chatChannels![0].name).toEqual('chat-channel')
      expect(adapter!.dmChannels).toHaveLength(2)

      // Verify agent references were properly replaced
      const testAgentId = conversation!.agents.find((a) => a.agentType === 'test')!._id
      const manualAgentId = conversation!.agents.find((a) => a.agentType === 'testManual')!._id

      expect(adapter!.dmChannels!.some((dm) => dm.agent!.toString() === testAgentId!.toString())).toBe(true)
      expect(adapter!.dmChannels!.some((dm) => dm.agent!.toString() === manualAgentId!.toString())).toBe(true)
    })

    test('should return 201 and handle empty channel arrays gracefully', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Empty Channel Arrays',
          topicId: publicTopic._id.toString(),
          channels: [{ name: 'test-channel', passcode: 'TestPass' }],
          adapters: [
            {
              type: 'zoom',
              config: { meetingUrl: 'http://zoom.meeting' },
              audioChannels: [],
              chatChannels: [],
              dmChannels: []
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)

      const conversation = await Conversation.findById(resp.body.id)
      const adapter = await Adapter.findOne({ conversation: conversation!._id })

      expect(adapter).toBeTruthy()
      expect(adapter!.audioChannels).toEqual([])
      expect(adapter!.chatChannels).toEqual([])
      expect(adapter!.dmChannels).toEqual([])
    })

    test('should start adapter when conversation is immediately started', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Adapter Start',
          topicId: publicTopic._id.toString(),
          agentTypes: ['test'], // This will trigger immediate start
          adapters: [
            {
              type: 'slack',
              config: { webhookUrl: 'http://slack.webhook.com' }
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)
      expect(mockAdapterStart).toHaveBeenCalled()

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation!.active).toBe(true)
    })

    test('should not start adapter when conversation is scheduled', async () => {
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Test Scheduled Adapter',
          topicId: publicTopic._id.toString(),
          scheduledTime: '2025-03-25T16:15:00Z',
          agentTypes: ['test'],
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'scheduled-meeting' }
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(1)

      expect(mockAdapterStart).not.toHaveBeenCalled()

      const conversation = await Conversation.findById(resp.body.id)
      expect(conversation!.active).toBe(false)
      expect(conversation!.scheduledTime).toEqual(new Date('2025-03-25T16:15:00Z'))
    })
    test('should return 400 when creating scheduled conversation with adapter that conflicts with another scheduled conversation', async () => {
      mockGetUniqueKeys.mockReturnValue(['config.meetingId'])

      // Create first scheduled conversation with adapter
      const firstScheduledTime = new Date('2025-03-25T16:00:00Z')
      const resp1 = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'First Scheduled Adapter Conversation',
          topicId: publicTopic._id.toString(),
          scheduledTime: firstScheduledTime.toISOString(),
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'meeting-123' }
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp1.body.adapters).toHaveLength(1)
      expect(resp1.body.scheduledTime).toBe(firstScheduledTime.toISOString())

      // Attempt to create second conversation with same adapter within 10 minutes
      const secondScheduledTime = new Date('2025-03-25T16:05:00Z') // 5 minutes later
      await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Second Scheduled Adapter Conversation',
          topicId: publicTopic._id.toString(),
          scheduledTime: secondScheduledTime.toISOString(),
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'meeting-123' }
            }
          ]
        })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 201 when creating scheduled conversation with adapters that have the same unique keys', async () => {
      mockGetUniqueKeys.mockReturnValue(['config.meetingId'])

      const scheduledTime = new Date('2025-03-25T16:00:00Z')

      // Create conversation with adapter
      const resp = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Scheduled Adapter Conversation',
          topicId: publicTopic._id.toString(),
          scheduledTime: scheduledTime.toISOString(),
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'meeting-456' }
            },
            {
              type: 'zoom',
              config: { meetingId: 'meeting-456' }
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp.body.adapters).toHaveLength(2)
      expect(resp.body.scheduledTime).toBe(scheduledTime.toISOString())
    })

    test('should return 201 when creating scheduled conversation with same adapter keys outside 10 minute window', async () => {
      mockGetUniqueKeys.mockReturnValue(['config.meetingId'])

      // Create first scheduled conversation with adapter
      const firstScheduledTime = new Date('2025-03-25T16:00:00Z')
      const resp1 = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'First Scheduled Adapter Conversation',
          topicId: publicTopic._id.toString(),
          scheduledTime: firstScheduledTime.toISOString(),
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'meeting-789' }
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp1.body.adapters).toHaveLength(1)

      // Create second conversation with same adapter outside 10 minute window (11 minutes later)
      const secondScheduledTime = new Date('2025-03-25T16:11:00Z')
      const resp2 = await request(app)
        .post(`/v1/conversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({
          name: 'Second Scheduled Adapter Conversation',
          topicId: publicTopic._id.toString(),
          scheduledTime: secondScheduledTime.toISOString(),
          adapters: [
            {
              type: 'zoom',
              config: { meetingId: 'meeting-789' }
            }
          ]
        })
        .expect(httpStatus.CREATED)

      expect(resp2.body.adapters).toHaveLength(1)
      expect(resp2.body.scheduledTime).toBe(secondScheduledTime.toISOString())
    })
  })

  describe('GET /v1/conversations/topic/:topicId', () => {
    test('should return 200 and body should be all non-experimental conversations for supplied topic', async () => {
      const resp = await request(app)
        .get(`/v1/conversations/topic/${publicTopic._id.toString()}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(2)
      // One or the other
      expect([conversationOne._id.toString(), conversationAgentsEnabled._id.toString()]).toContain(resp.body[0].id)
    })
  })

  describe('GET /v1/conversations/userConversations', () => {
    test('should return 200 and body should be all non-experimental conversations for logged-in user', async () => {
      const resp = await request(app)
        .get(`/v1/conversations/userConversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(2)
    })

    test('should return 200 and conversations should include followed', async () => {
      await insertFollowers([conversationFollow])
      const resp = await request(app)
        .get(`/v1/conversations/userConversations`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(3)
    })
  })

  describe('POST /v1/conversations/:conversationId/start', () => {
    test('should return 200. set agent and conversation started props, and activate manual agent', async () => {
      const spy = jest.spyOn(schedule, 'agentResponse').mockResolvedValue()
      const agent = new Agent({
        agentType: 'testManual',
        conversation: agentConversation
      })
      await agent.save()

      agentConversation.agents.push(agent)
      await agentConversation.save()
      const url = `/v1/conversations/${agentConversation._id.toString()}/start`
      const resp = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)
      expect(spy).toHaveBeenCalled()
      expect(mockStart).toHaveBeenCalled()
      expect(resp.body.startTime).toBeDefined()
      const modifiedAgent = await Agent.findOne({ _id: agent._id })
      expect(modifiedAgent!.active).toBe(true)
    })
    test('should return 200 and start adapters', async () => {
      const adapter = new Adapter({
        type: 'slack',
        conversation: agentConversation
      })
      await adapter.save()

      agentConversation.adapters.push(adapter)
      await agentConversation.save()
      const url = `/v1/conversations/${agentConversation._id.toString()}/start`
      await request(app).post(url).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)
      expect(mockAdapterStart).toHaveBeenCalled()
    })
    test('should return 200 attempting to start a conversation is that is already started', async () => {
      const agent = new Agent({
        agentType: 'testManual',
        conversation: agentConversation
      })
      await agent.save()

      agentConversation.agents.push(agent)
      await agentConversation.save()
      const url = `/v1/conversations/${agentConversation._id.toString()}/start`
      await request(app).post(url).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)

      await request(app).post(url).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)
    })
  })

  describe('POST /v1/conversations/:conversationId/stop', () => {
    test('should return 200 and set agent and conversation stopped props', async () => {
      const agent = new Agent({
        agentType: 'testManual',
        conversation: agentConversation
      })
      await agent.save()

      agentConversation.agents.push(agent)
      await agentConversation.save()

      // Start the conversation first
      const startUrl = `/v1/conversations/${agentConversation._id.toString()}/start`
      await request(app).post(startUrl).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)

      const url = `/v1/conversations/${agentConversation._id.toString()}/stop`
      const resp = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)
      expect(mockStop).toHaveBeenCalled()
      expect(resp.body.endTime).toBeDefined()
      const modifiedAgent = await Agent.findOne({ _id: agent._id })
      expect(modifiedAgent!.active).toBe(false)
      expect(cancelBatchTranscriptSpy).toHaveBeenCalledWith(agentConversation!._id)
    })
    test('should return 200 and stop adapters', async () => {
      const adapter = new Adapter({
        type: 'slack',
        conversation: agentConversation
      })
      await adapter.save()
      agentConversation.adapters.push(adapter)
      await agentConversation.save()

      // Start the conversation first
      const startUrl = `/v1/conversations/${agentConversation._id.toString()}/start`
      await request(app).post(startUrl).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)

      const url = `/v1/conversations/${agentConversation._id.toString()}/stop`
      await request(app).post(url).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)
      expect(mockAdapterStop).toHaveBeenCalled()
    })
    test('should return 200 attempting to stop a conversation is that is not started', async () => {
      const agent = new Agent({
        agentType: 'testManual',
        conversation: agentConversation
      })
      await agent.save()

      agentConversation.agents.push(agent)
      await agentConversation.save()

      const url = `/v1/conversations/${agentConversation._id.toString()}/stop`
      await request(app).post(url).set('Authorization', `Bearer ${userOneAccessToken}`).send().expect(httpStatus.OK)
    })
  })

  describe('GET /v1/conversations/:conversationId', () => {
    test('should return 200 and return agents and adapters', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agentSpecification: any = {
        agentType: 'test',
        conversation: agentConversation,
        agentConfig: {
          pseudonym: 'Test agent #1',
          otherData: true
        }
      }
      const agent = new Agent(agentSpecification)
      await agent.save()

      const adapter = new Adapter({
        type: 'slack',
        conversation: agentConversation
      })
      await adapter.save()
      const scheduledTime = new Date()
      agentConversation.scheduledTime = scheduledTime
      agentConversation.description = 'A conversation about something'
      agentConversation.presenters = [{ name: 'Ann Speaker', bio: 'An experienced speaker' }]
      agentConversation.moderators = [{ name: 'Joe Moderator', bio: 'An experienced moderator' }]
      agentConversation.adapters.push(adapter)
      await agentConversation.save()

      const expectedAgentTypeSpecification = testAgentTypeSpecification.test

      agentSpecification.conversation = agentConversation._id.toString()

      // this is incomplete, but covers representative fields
      const expectedAgentResponse = {
        ...agentSpecification,
        name: expectedAgentTypeSpecification.name,
        description: expectedAgentTypeSpecification.description,
        priority: expectedAgentTypeSpecification.priority,
        llmTemplateVars: expectedAgentTypeSpecification.llmTemplateVars,
        llmTemplates: expectedAgentTypeSpecification.defaultLLMTemplates,
        conversationName: agentConversation.name
      }

      const expectedAdapterResponse = {
        type: 'slack',
        audioChannels: [],
        dmChannels: [],
        chatChannels: []
      }

      const expectedResponse = {
        name: agentConversation.name,
        slug: agentConversation.slug,
        locked: agentConversation.locked,
        id: agentConversation._id.toString(),
        owner: agentConversation.owner._id.toString(),
        scheduledTime: scheduledTime.toISOString(),
        description: agentConversation.description,
        presenters: [{ name: 'Ann Speaker', bio: 'An experienced speaker' }],
        moderators: [{ name: 'Joe Moderator', bio: 'An experienced moderator' }]
      }
      agentConversation.agents.push(agent)
      await agentConversation.save()

      const url = `/v1/conversations/${agentConversation._id.toString()}`
      const resp = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body.agents).toHaveLength(1)
      expect(resp.body.agents[0]).toMatchObject(expectedAgentResponse)
      expect(resp.body.adapters).toHaveLength(1)
      expect(resp.body.adapters[0]).toMatchObject(expectedAdapterResponse)
      expect(resp.body).toMatchObject(expectedResponse)
    })
  })

  describe('POST /v1/conversations/:conversationId/join', () => {
    test('should return 200 and join conversation without creating DM channels when DMs are not enabled', async () => {
      // Create conversation without enableDMs
      const conversationWithoutDMs = new Conversation({
        name: 'No DM Conversation',
        owner: userOne,
        topic: publicTopic,
        enableDMs: [], // No DMs enabled
        agents: []
      })
      await conversationWithoutDMs.save()

      const resp = await request(app)
        .post(`/v1/conversations/${conversationWithoutDMs._id}/join`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body.id).toBe(conversationWithoutDMs._id.toString())
      expect(resp.body.channels).toHaveLength(0)
    })

    test('should return 200 and create direct message channels when enableDMs includes agents', async () => {
      // Create conversation with agents and DMs enabled
      const conversationWithAgents = new Conversation({
        name: 'DM Enabled Conversation',
        owner: userOne,
        topic: publicTopic,
        enableDMs: ['agents'],
        agents: []
      })
      await conversationWithAgents.save()

      // Create test agent with direct message triggers
      const testAgent = new Agent({
        agentType: 'test',
        conversation: conversationWithAgents._id,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await testAgent.save()

      conversationWithAgents.agents = [testAgent]
      await conversationWithAgents.save()

      const resp = await request(app)
        .post(`/v1/conversations/${conversationWithAgents._id}/join`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body.id).toBe(conversationWithAgents._id.toString())
      expect(resp.body.channels).toHaveLength(1)
      expect(resp.body.channels[0].name).toBe(`direct-${userTwo._id}-${testAgent._id}`)
      expect(resp.body.channels[0].direct).toBe(true)

      // Verify channel was actually created in database
      const updatedConversation = await Conversation.findById(conversationWithAgents._id).populate('channels')
      expect(updatedConversation!.channels).toHaveLength(1)
      const channel = updatedConversation!.channels[0]
      expect(channel.name).toBe(`direct-${userTwo._id}-${testAgent._id}`)
      expect(channel.direct).toBe(true)
      expect(channel.passcode).toBeNull()
      expect(channel.participants).toHaveLength(2)
      expect(channel.participants!.some((p) => p.toString() === userTwo._id.toString())).toBe(true)
      expect(channel.participants!.some((p) => p.toString() === testAgent._id.toString())).toBe(true)
    })

    test('should return 200 and create multiple DM channels for multiple agents with DM triggers', async () => {
      const conversationMultiAgent = new Conversation({
        name: 'Multi Agent DM Conversation',
        owner: userOne,
        topic: publicTopic,
        enableDMs: ['agents'],
        agents: []
      })
      await conversationMultiAgent.save()

      // Create two agents with direct message triggers
      const testAgent1 = new Agent({
        agentType: 'test',
        conversation: conversationMultiAgent._id,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await testAgent1.save()

      const testAgent2 = new Agent({
        agentType: 'testManual',
        conversation: conversationMultiAgent._id,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await testAgent2.save()

      conversationMultiAgent.agents = [testAgent1, testAgent2]
      await conversationMultiAgent.save()

      const resp = await request(app)
        .post(`/v1/conversations/${conversationMultiAgent._id}/join`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body.channels).toHaveLength(2)
      const channelNames = resp.body.channels.map((c) => c.name)
      expect(channelNames).toContain(`direct-${userTwo._id}-${testAgent1._id}`)
      expect(channelNames).toContain(`direct-${userTwo._id}-${testAgent2._id}`)
    })

    test('should return 200 and not create duplicate DM channels on subsequent joins', async () => {
      const conversationWithAgent = new Conversation({
        name: 'Duplicate Test Conversation',
        owner: userOne,
        topic: publicTopic,
        enableDMs: ['agents'],
        agents: []
      })
      await conversationWithAgent.save()

      const testAgent = new Agent({
        agentType: 'test',
        conversation: conversationWithAgent._id,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await testAgent.save()

      conversationWithAgent.agents = [testAgent]
      await conversationWithAgent.save()

      // Join first time
      const resp1 = await request(app)
        .post(`/v1/conversations/${conversationWithAgent._id}/join`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp1.body.channels).toHaveLength(1)

      // Join second time - should not create duplicate
      const resp2 = await request(app)
        .post(`/v1/conversations/${conversationWithAgent._id}/join`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp2.body.channels).toHaveLength(1)

      // Verify only one channel exists in database
      const updatedConversation = await Conversation.findById(conversationWithAgent._id).populate('channels')
      expect(updatedConversation!.channels).toHaveLength(1)
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .post(`/v1/conversations/${nonExistentId}/join`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      await request(app).post(`/v1/conversations/${conversationOne._id}/join`).send().expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .post('/v1/conversations/invalid-id/join')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('GET /v1/conversations/active', () => {
    test('should return 200 and body should be all active non-experimental conversations with message counts', async () => {
      // Start some conversations to make them active
      await Conversation.findByIdAndUpdate(conversationOne._id, { active: true })
      await Conversation.findByIdAndUpdate(conversationTwo._id, { active: true })
      // conversationThree remains inactive

      const resp = await request(app)
        .get(`/v1/conversations/active`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(2)

      const t1 = resp.body.find((x) => x.id === conversationOne._id.toString())
      expect(t1).toBeDefined()
      expect(t1.messageCount).toEqual(1)
      expect(t1.active).toBe(true)

      const t2 = resp.body.find((x) => x.id === conversationTwo._id.toString())
      expect(t2).toBeDefined()
      expect(t2.messageCount).toEqual(2)
      expect(t2.active).toBe(true)

      // conversationThree should not be in results since it's not active
      const t3 = resp.body.find((x) => x.id === conversationThree._id.toString())
      expect(t3).toBeUndefined()
    })

    test('should return 200 and empty array when no conversations are active', async () => {
      // Ensure all conversations are inactive
      await Conversation.updateMany({}, { active: false })

      const resp = await request(app)
        .get(`/v1/conversations/active`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(0)
    })

    test('should not return experimental conversations even if they are active', async () => {
      // Make experimental conversation active
      await Conversation.findByIdAndUpdate(experimentalConversation._id, { active: true })
      // Make a regular conversation active for comparison
      await Conversation.findByIdAndUpdate(conversationOne._id, { active: true })

      const resp = await request(app)
        .get(`/v1/conversations/active`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      // Should only contain conversationOne, not experimentalConversation
      expect(resp.body).toHaveLength(1)
      expect(resp.body[0].id).toBe(conversationOne._id.toString())

      // Verify experimental conversation is not in results
      const experimentalInResults = resp.body.find((x) => x.id === experimentalConversation._id.toString())
      expect(experimentalInResults).toBeUndefined()
    })

    test('should return conversations with all required fields', async () => {
      await Conversation.findByIdAndUpdate(conversationOne._id, { active: true })

      const resp = await request(app)
        .get(`/v1/conversations/active`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(resp.body).toHaveLength(1)
      const conversation = resp.body[0]

      // Check that all returnFields are present
      expect(conversation).toHaveProperty('name')
      expect(conversation).toHaveProperty('slug')
      expect(conversation).toHaveProperty('locked')
      expect(conversation).toHaveProperty('owner')
      expect(conversation).toHaveProperty('createdAt')
      expect(conversation).toHaveProperty('active')
      expect(conversation).toHaveProperty('id')
      expect(conversation).not.toHaveProperty('messages')
      expect(conversation).not.toHaveProperty('_id')
    })

    test('should return 401 when no authentication token provided', async () => {
      await request(app).get(`/v1/conversations/active`).send().expect(httpStatus.UNAUTHORIZED)
    })

    test('should handle case where active conversation has no messages', async () => {
      // Create a conversation with no messages and make it active
      const conversationWithNoMessages = new Conversation({
        name: 'No Messages Conversation',
        owner: userOne,
        topic: publicTopic,
        active: true,
        messages: []
      })
      await conversationWithNoMessages.save()

      const resp = await request(app)
        .get(`/v1/conversations/active`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      const noMsgConversation = resp.body.find((x) => x.id === conversationWithNoMessages._id.toString())
      expect(noMsgConversation).toBeDefined()
      expect(noMsgConversation.messageCount).toEqual(0)
    })
  })
  describe('DELETE /v1/conversations/:conversationId', () => {
    test('should return 200 and delete conversation when user is conversation owner', async () => {
      await request(app)
        .delete(`/v1/conversations/${conversationOne._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      // Verify conversation is deleted from database
      const deletedConversation = await Conversation.findById(conversationWithChannels._id)
      expect(deletedConversation).toBeNull()

      // Verify related data is cleaned up
      const followers = await Follower.find({ conversation: conversationWithChannels._id })
      expect(followers).toHaveLength(0)

      const messages = await Message.find({ conversation: conversationOne._id })
      expect(messages).toHaveLength(0)

      const agents = await Agent.find({ conversation: conversationOne._id })
      expect(agents).toHaveLength(0)

      const channels = await Channel.find({ conversation: conversationOne._id })
      expect(channels).toHaveLength(0)

      const adapters = await Adapter.find({ conversation: conversationOne._id })
      expect(adapters).toHaveLength(0)
    })

    test('should return 200 and delete conversation when user is topic owner', async () => {
      // conversationTwo belongs to publicTopic which is owned by userOne
      await request(app)
        .delete(`/v1/conversations/${conversationTwo._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      const deletedConversation = await Conversation.findById(conversationTwo._id)
      expect(deletedConversation).toBeNull()
    })

    test('should stop active conversation before deletion', async () => {
      // Create an active conversation with agents
      const activeConversation = new Conversation({
        topic: publicTopic._id,
        enableAgents: true,
        name: 'Test Conversation',
        active: true,
        owner: userOne._id
      })
      await activeConversation.save()

      // Create test agents for the conversation
      const testAgent = new Agent({
        agentType: 'test',
        conversation: activeConversation._id,
        useTranscriptRAGCollection: true
      })
      await testAgent.save()
      activeConversation.agents = [testAgent]
      await activeConversation.save()

      await request(app)
        .delete(`/v1/conversations/${activeConversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      // Verify stop methods were called
      expect(mockStop).toHaveBeenCalled()
      expect(cancelBatchTranscriptSpy).toHaveBeenCalledWith(activeConversation._id)

      const deletedConversation = await Conversation.findById(activeConversation._id)
      expect(deletedConversation).toBeNull()
    })

    test('should delete transcript RAG collection when conversation deleted', async () => {
      const transcriptSpy = jest.spyOn(transcript, 'deleteTranscript').mockResolvedValue()

      // Create conversation with RAG-enabled agent
      const ragConversation = new Conversation({
        topic: publicTopic._id,
        enableAgents: true,
        name: 'RAG Conversation',
        owner: userOne._id
      })
      await ragConversation.save()

      const ragAgent = new Agent({
        agentType: 'test',
        conversation: ragConversation._id,
        useTranscriptRAGCollection: true
      })
      await ragAgent.save()
      ragConversation.agents = [ragAgent]
      await ragConversation.save()

      await request(app)
        .delete(`/v1/conversations/${ragConversation._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      expect(transcriptSpy).toHaveBeenCalled()
      transcriptSpy.mockRestore()
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .delete(`/v1/conversations/${nonExistentId}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      await request(app).delete(`/v1/conversations/${conversationOne._id}`).send().expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 403 when user is not conversation owner or topic owner', async () => {
      // userTwo tries to delete conversationOne (owned by userOne, topic owned by userOne)
      await request(app)
        .delete(`/v1/conversations/${conversationOne._id}`)
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send()
        .expect(httpStatus.FORBIDDEN)

      // Verify conversation still exists
      const conversation = await Conversation.findById(conversationOne._id)
      expect(conversation).toBeTruthy()
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .delete('/v1/conversations/invalid-id')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should clean up followers when deleting conversation', async () => {
      // Insert follower for conversationOne
      await insertFollowers([conversationFollow])

      await request(app)
        .delete(`/v1/conversations/${conversationOne._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      // Verify follower is deleted
      const followers = await Follower.find({ conversation: conversationOne._id })
      expect(followers).toHaveLength(0)
    })

    test('should clean up channels when deleting conversation', async () => {
      const conversation1 = await Conversation.findOne({ _id: conversationOne._id })
      const [channel1, channel2] = await Channel.create(
        { name: 'channel1', passcode: 'Channel1_CoDe' },
        { name: 'channel2', passcode: 'channel2_CODE' }
      )
      conversation1!.channels.push(channel1)
      conversation1!.channels.push(channel2)
      await conversation1!.save()

      await request(app)
        .delete(`/v1/conversations/${conversationOne._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      // Verify channels are deleted
      const channels = await Channel.find({ name: 'channel1' })
      expect(channels).toHaveLength(0)
      const channels2 = await Channel.find({ name: 'channel2' })
      expect(channels2).toHaveLength(0)
    })

    test('should clean up adapters when deleting conversation', async () => {
      // Create conversation with adapters
      const conversationWithAdapters = new Conversation({
        topic: publicTopic._id,
        enableAgents: true,
        name: 'Adapter Conversation',
        owner: userOne._id
      })
      await conversationWithAdapters.save()

      const testAdapter = new Adapter({
        type: 'slack',
        config: { token: 'test-token' },
        conversation: conversationWithAdapters._id
      })
      await testAdapter.save()

      await request(app)
        .delete(`/v1/conversations/${conversationWithAdapters._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send()
        .expect(httpStatus.OK)

      // Verify adapters are deleted
      const adapters = await Adapter.find({ conversation: conversationWithAdapters._id })
      expect(adapters).toHaveLength(0)
    })
  })

  describe('PUT /v1/conversations', () => {
    let broadcastSpy

    beforeEach(async () => {
      broadcastSpy = jest.spyOn(websocketGateway, 'broadcastConversationUpdate').mockResolvedValue()
    })

    afterEach(async () => {
      jest.clearAllMocks()
    })

    test('should return 200 and update conversation when user is conversation owner', async () => {
      const updateBody = {
        id: conversationOne._id,
        name: 'Updated Conversation Name',
        locked: true
      }

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(res.body.name).toBe(updateBody.name)
      expect(res.body.locked).toBe(true)

      // Verify database was updated
      const updatedConversation = await Conversation.findById(conversationOne._id)
      expect(updatedConversation?.name).toBe(updateBody.name)
      expect(updatedConversation?.locked).toBe(true)
    })

    test('should return 200 and update conversation when user is topic owner', async () => {
      const updateBody = {
        id: conversationTwo._id,
        name: 'Topic Owner Update'
      }

      // conversationTwo belongs to publicTopic which is owned by userOne
      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(res.body.name).toBe(updateBody.name)

      const updatedConversation = await Conversation.findById(conversationTwo._id)
      expect(updatedConversation?.name).toBe(updateBody.name)
    })

    test('should broadcast conversation update via websocket', async () => {
      const updateBody = {
        id: conversationOne._id,
        name: 'Broadcast Test'
      }

      await request(app)
        .put('/v1/conversations/')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(broadcastSpy).toHaveBeenCalled()
      const broadcastedConversation = broadcastSpy.mock.calls[0][0]
      expect(broadcastedConversation.name).toBe(updateBody.name)

      broadcastSpy.mockRestore()
    })

    test('should update transcript RAG when conversation has RAG-enabled agents', async () => {
      const transcriptSpy = jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue()

      // Create conversation with RAG-enabled agent
      const ragConversation = new Conversation({
        topic: publicTopic._id,
        enableAgents: true,
        name: 'RAG Conversation',
        owner: userOne._id
      })
      await ragConversation.save()

      const ragAgent = new Agent({
        agentType: 'test',
        conversation: ragConversation._id,
        useTranscriptRAGCollection: true
      })
      await ragAgent.save()
      ragConversation.agents = [ragAgent]
      await ragConversation.save()

      const updateBody = {
        id: ragConversation._id,
        name: 'Updated RAG Conversation'
      }

      await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(transcriptSpy).toHaveBeenCalledWith(expect.objectContaining({ _id: ragConversation._id }))
      transcriptSpy.mockRestore()
    })

    test('should not update transcript RAG when conversation has no RAG-enabled agents', async () => {
      const transcriptSpy = jest.spyOn(transcript, 'loadEventMetadataIntoVectorStore').mockResolvedValue()

      const updateBody = {
        id: conversationOne._id,
        name: 'Updated No RAG Conversation'
      }

      await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(transcriptSpy).not.toHaveBeenCalled()
      transcriptSpy.mockRestore()
    })

    test('should update multiple fields at once', async () => {
      const updateBody = {
        id: conversationOne._id,
        name: 'Multi-field Update',
        description: 'A fun event',
        presenters: [
          { name: 'Alice', bio: 'Alice is a speaker' },
          { name: 'Bob', bio: 'Bob knows things' }
        ],
        moderators: [{ name: 'Charlie', bio: 'Charlie keeps order' }]
      }

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(res.body.name).toBe(updateBody.name)
      expect(res.body.description).toBe('A fun event')
      expect(res.body.presenters).toMatchObject([
        { name: 'Alice', bio: 'Alice is a speaker' },
        { name: 'Bob', bio: 'Bob knows things' }
      ])
      expect(res.body.moderators).toMatchObject([{ name: 'Charlie', bio: 'Charlie keeps order' }])

      const updatedConversation = await Conversation.findById(conversationOne._id)
      expect(updatedConversation?.name).toBe(updateBody.name)
      expect(updatedConversation?.description).toBe('A fun event')
      expect(updatedConversation?.presenters).toMatchObject([
        { name: 'Alice', bio: 'Alice is a speaker' },
        { name: 'Bob', bio: 'Bob knows things' }
      ])
      expect(updatedConversation?.moderators).toMatchObject([{ name: 'Charlie', bio: 'Charlie keeps order' }])
    })

    test('should return 404 when conversation does not exist', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ id: nonExistentId, name: 'Test' })
        .expect(httpStatus.NOT_FOUND)
    })

    test('should return 401 when no auth token provided', async () => {
      await request(app)
        .put('/v1/conversations/')
        .send({ name: 'Test', id: conversationOne._id })
        .expect(httpStatus.UNAUTHORIZED)
    })

    test('should return 403 when user is not conversation owner or topic owner', async () => {
      // userTwo tries to update conversationOne (owned by userOne, topic owned by userOne)
      await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userTwoAccessToken}`)
        .send({ name: 'Unauthorized Update', id: conversationOne._id })
        .expect(httpStatus.FORBIDDEN)

      // Verify conversation was not updated
      const conversation = await Conversation.findById(conversationOne._id)
      expect(conversation?.name).not.toBe('Unauthorized Update')
    })

    test('should return 400 when conversationId is invalid ObjectId', async () => {
      await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ name: 'Test', id: 'invalid-id' })
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should preserve fields that are not in update body', async () => {
      const originalConversation = await Conversation.findById(conversationOne._id)
      const originalName = originalConversation?.name

      const updateBody = {
        id: conversationOne._id,
        locked: true
      }

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      // Name should remain unchanged
      expect(res.body.name).toBe(originalName)
      expect(res.body.locked).toBe(true)

      const updatedConversation = await Conversation.findById(conversationOne._id)
      expect(updatedConversation?.name).toBe(originalName)
      expect(updatedConversation?.locked).toBe(true)
    })

    test('should handle empty update body', async () => {
      const originalConversation = await Conversation.findById(conversationOne._id)
      const originalName = originalConversation?.name

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ id: conversationOne._id })
        .expect(httpStatus.OK)

      // Conversation should remain unchanged
      expect(res.body.name).toBe(originalName)

      const conversation = await Conversation.findById(conversationOne._id)
      expect(conversation?.name).toBe(originalName)
    })

    test('should allow topic owner to update conversation they do not own', async () => {
      // Create a conversation owned by userTwo but in userOne's topic
      const conversationOwnedByUserTwo = new Conversation({
        name: 'UserTwo Conversation',
        owner: userTwo._id,
        topic: publicTopic._id, // publicTopic is owned by userOne
        messages: []
      })
      await conversationOwnedByUserTwo.save()

      const updateBody = {
        id: conversationOwnedByUserTwo._id,
        name: 'Updated by Topic Owner'
      }

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`) // userOne is topic owner
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(res.body.name).toBe(updateBody.name)

      const updatedConversation = await Conversation.findById(conversationOwnedByUserTwo._id)
      expect(updatedConversation?.name).toBe(updateBody.name)
    })

    test('should handle updating locked field to false', async () => {
      // First set locked to true
      await Conversation.findByIdAndUpdate(conversationOne._id, { locked: true })

      const updateBody = {
        id: conversationOne._id,
        locked: false
      }

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      expect(res.body.locked).toBe(false)

      const updatedConversation = await Conversation.findById(conversationOne._id)
      expect(updatedConversation?.locked).toBe(false)
    })

    test('should populate topic when returning updated conversation', async () => {
      const updateBody = {
        id: conversationOne._id,
        name: 'Populated Topic Test'
      }

      const res = await request(app)
        .put('/v1/conversations')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send(updateBody)
        .expect(httpStatus.OK)

      // The response should include conversation data
      expect(res.body).toHaveProperty('name')
      expect(res.body.name).toBe(updateBody.name)
    })
  })
})
