import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, registeredUser, userOne } from '../fixtures/user.fixture.js'
import { registeredUserAccessToken } from '../fixtures/token.fixture.js'
import { insertConversations, publicTopic } from '../fixtures/conversation.fixture.js'
import Experiment from '../../src/models/experiment.model/experiment.js'
import { Agent, Message, Conversation, Channel } from '../../src/models/index.js'
import { insertMessages } from '../fixtures/message.fixture.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { AgentMessageActions } from '../../src/types/index.types.js'

jest.setTimeout(10000)
setupIntTest()

const mockRespond = jest.fn()
const mockStart = jest.fn()

// Test fixtures
const baseConversationId = new mongoose.Types.ObjectId()
const agentId = new mongoose.Types.ObjectId()
const agentId2 = new mongoose.Types.ObjectId()
const agentTextId = new mongoose.Types.ObjectId()
// Generate expected times dynamically to match any timezone
const formatTime = (timestamp) => {
  if (!timestamp) return 'No timestamp'
  return new Date(timestamp).toLocaleTimeString()
}

const formatDate = (timestamp) => {
  if (!timestamp) return 'No date'
  return new Date(timestamp).toLocaleString()
}

const testAgentTypeSpecification = {
  test: {
    respond: mockRespond,
    start: mockStart,
    name: 'Test Agent',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 300 } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini'
  },
  generic: {
    respond: mockRespond,
    start: mockStart,
    name: 'Generic Agent',
    description: 'An generic agent type, meant to be customized by a user',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 300 } },
    priority: 10,
    llmTemplateVars: { main: [] },
    defaultLLMTemplates: {
      main: 'You are an un-configured Generic Agent. Please configure me.'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini'
  },
  testText: {
    respond: mockRespond,
    start: mockStart,
    name: 'Test Text Agent',
    description: 'A test agent that responds in text',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 300 } },
    priority: 100,
    llmTemplateVars: { contribution: [], voting: [] },
    defaultLLMTemplates: {
      contribution: 'You are an agent that does awesome stuff. Be awesome!',
      voting: 'You should vote on this data {voteData}'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini'
  }
}

async function insertTestConversation() {
  const channels = await Channel.create([{ name: 'moderator' }, { name: 'participant' }])

  const testConversation = {
    _id: baseConversationId,
    name: 'Test Conversation',
    topic: publicTopic._id,
    description: 'A test conversation for experiments',
    messages: [],
    channels,
    owner: registeredUser._id,
    createdAt: new Date('2024-01-01T10:00:00Z'),
    updatedAt: new Date('2024-01-01T12:00:00Z')
  }
  return insertConversations([testConversation])
}

const userMessage = {
  _id: new mongoose.Types.ObjectId(),
  body: 'Hello, this is a user message',
  conversation: baseConversationId,
  createdBy: registeredUser._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  fromAgent: false,
  createdAt: new Date('2024-01-01T10:30:00Z'),
  updatedAt: new Date('2024-01-01T10:30:00Z')
}

const userMessage2 = {
  _id: new mongoose.Types.ObjectId(),
  body: 'Hello, this is another user message',
  conversation: baseConversationId,
  createdBy: registeredUser._id,
  pseudonym: registeredUser.pseudonyms[0].pseudonym,
  pseudonymId: registeredUser.pseudonyms[0]._id,
  fromAgent: false,
  createdAt: new Date('2024-01-01T10:34:00Z'),
  updatedAt: new Date('2024-01-01T10:34:00Z')
}

const testAgent = {
  _id: agentId,
  conversation: baseConversationId,
  agentType: 'test',
  pseudonyms: [
    {
      _id: new mongoose.Types.ObjectId(),
      token:
        '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
      pseudonym: 'TestAgent',
      active: 'true'
    }
  ]
}

const genericAgentId = new mongoose.Types.ObjectId()
const testGenericAgent = {
  _id: genericAgentId,
  conversation: baseConversationId,
  agentType: 'generic',
  pseudonyms: [
    {
      _id: new mongoose.Types.ObjectId(),
      token:
        '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
      pseudonym: 'GenericAgent',
      active: 'true'
    }
  ]
}

const testAgent2 = {
  _id: agentId2,
  conversation: baseConversationId,
  agentType: 'test',
  pseudonyms: [
    {
      _id: new mongoose.Types.ObjectId(),
      token:
        '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
      pseudonym: 'TestAgent',
      active: 'true'
    }
  ]
}

const testTextAgent = {
  _id: agentTextId,
  conversation: baseConversationId,
  agentType: 'testText',
  pseudonyms: [
    {
      _id: new mongoose.Types.ObjectId(),
      token:
        '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
      pseudonym: 'Test Text Agent',
      active: 'true'
    }
  ]
}

const agentMessage = {
  _id: new mongoose.Types.ObjectId(),
  body: 'Hello, this is an agent response',
  conversation: baseConversationId,
  pseudonym: testAgent.pseudonyms[0].pseudonym,
  pseudonymId: testAgent.pseudonyms[0]._id,
  fromAgent: true,
  createdAt: new Date('2024-01-01T11:00:00Z'),
  updatedAt: new Date('2024-01-01T11:00:00Z')
}

const experimentCreateRequest = {
  name: 'Test Experiment',
  description: 'A test experiment to validate functionality',
  baseConversation: baseConversationId.toString(),
  agentModifications: [
    {
      agent: agentId,
      experimentValues: {
        llmTemplates: { contribution: 'Do something bizarre' }
      }
    }
  ]
}

describe('Experiment routes', () => {
  beforeAll(() => {
    setAgentTypes(testAgentTypeSpecification)
  })
  beforeEach(async () => {
    await insertTopics([publicTopic])
  })
  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })
  afterEach(() => {
    jest.clearAllMocks()
  })
  describe('POST /v1/experiments', () => {
    test('should return 201 and create experiment with result conversation', async () => {
      await insertUsers([registeredUser])
      const [conversation] = await insertTestConversation()

      const agent = await Agent.create(testAgent)
      conversation.agents.push(agent)
      await insertMessages([userMessage, agentMessage])
      await conversation.save()

      const response = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentCreateRequest)
        .expect(httpStatus.CREATED)

      expect(response.body).toHaveProperty('name', experimentCreateRequest.name)
      expect(response.body).toHaveProperty('description', experimentCreateRequest.description)
      expect(response.body.baseConversation).toEqual(conversation.id.toString())
      expect(response.body.createdBy).toEqual(registeredUser._id.toString())
      expect(response.body).toHaveProperty('resultConversation')

      // Verify experiment was created in database
      const experiment = await Experiment.findById(response.body.id)
      expect(experiment).toBeTruthy()
      expect(experiment!.name).toBe(experimentCreateRequest.name)
      expect(experiment!.createdBy.toString()).toBe(registeredUser._id.toString())
      expect(experiment!.status).toEqual('not started')
      // Verify result conversation was created
      const resultConversation = await Conversation.findById(experiment!.resultConversation).populate('messages').exec()
      expect(resultConversation).toBeTruthy()
      // verify prior agent message was removed from result conversation
      expect(resultConversation!.messages).toHaveLength(1)
      expect(resultConversation!.experimental).toBe(true)

      // Reload base conversation and verify updated with experiment
      const baseConversation = await Conversation.findById(experiment!.baseConversation)
      expect(baseConversation).toBeTruthy()
      expect(baseConversation!.experimental).toBe(false)
      expect(baseConversation!.experiments).toHaveLength(1)
    })

    test('should return 400 when base conversation does not exist', async () => {
      await insertUsers([registeredUser])

      const invalidRequest = {
        ...experimentCreateRequest,
        baseConversation: new mongoose.Types.ObjectId().toString()
      }

      await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(invalidRequest)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should return 400 when agent does not exist', async () => {
      await insertUsers([registeredUser])
      await insertTestConversation()

      const invalidAgentRequest = {
        ...experimentCreateRequest,
        agentModifications: [
          {
            agent: new mongoose.Types.ObjectId(),
            experimentValues: { conversationHistorySettings: { timeWindow: 1800 } }
          }
        ]
      }

      await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(invalidAgentRequest)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should validate required fields', async () => {
      await insertUsers([registeredUser])

      const incompleteRequest = {
        description: 'Cool experiment'
        // missing name and baseConversation
      }

      await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(incompleteRequest)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should validate required agent modification fields', async () => {
      await insertUsers([registeredUser])

      const incompleteRequest = {
        ...experimentCreateRequest,
        agentModifications: [
          {
            agent: new mongoose.Types.ObjectId()
          }
        ]
      }

      await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(incompleteRequest)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('should handle multiple agent modifications', async () => {
      await insertUsers([registeredUser])
      const [conversation] = await insertTestConversation()
      await insertMessages([userMessage, agentMessage])
      const agent = await Agent.create(testAgent)
      conversation.agents.push(agent)

      const agent2 = await Agent.create(testAgent2)
      conversation.agents.push(agent2)

      await conversation.save()

      const multiAgentRequest = {
        ...experimentCreateRequest,
        agentModifications: [
          {
            agent: agentId,
            experimentValues: { conversationHistorySettings: { timeWindow: 1800 } }
          },
          {
            agent: agentId2,
            experimentValues: { conversationHistorySettings: { timeWindow: 900 } }
          }
        ]
      }

      const response = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(multiAgentRequest)
        .expect(httpStatus.CREATED)

      expect(response.body).toHaveProperty('agentModifications')
      expect(response.body.agentModifications).toHaveLength(2)
    })

    test('should handle recording past experiments', async () => {
      await insertUsers([registeredUser])
      await insertTestConversation()
      const executedAt = new Date(Date.now() - 60 * 60 * 1000)
      const experimentBody = {
        name: 'Test Experiment',
        description: 'A test experiment to validate functionality',
        baseConversation: baseConversationId.toString(),
        executedAt
      }

      const response = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentBody)
        .expect(httpStatus.CREATED)

      expect(response.body).toHaveProperty('name', experimentCreateRequest.name)
      expect(response.body).toHaveProperty('description', experimentCreateRequest.description)
      expect(response.body).toHaveProperty('baseConversation')
      expect(response.body).toHaveProperty('executedAt')
      expect(response.body).not.toHaveProperty('agentModifications')

      // Verify experiment was created in database
      const experiment = await Experiment.findById(response.body.id)
      expect(experiment).toBeTruthy()
      expect(experiment!.name).toBe(experimentCreateRequest.name)
      expect(experiment!.createdBy.toString()).toBe(registeredUser._id.toString())
      expect(experiment!.executedAt).toEqual(experimentBody.executedAt)
      expect(experiment!.status).toEqual('completed')
    })
    test('should return 400 if agentModifications and executedAt are specified', async () => {
      await insertUsers([registeredUser])
      await insertTestConversation()
      const executedAt = new Date(Date.now() - 60 * 60 * 1000)
      const experimentBody = {
        ...experimentCreateRequest,
        executedAt
      }

      await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentBody)
        .expect(httpStatus.BAD_REQUEST)
    })
  })

  describe('POST /v1/experiments/:experimentId/run', () => {
    let createdExperiment
    let agent
    let conversation
    beforeEach(async () => {
      await insertUsers([registeredUser])
      ;[conversation] = await insertTestConversation()
      await insertMessages([userMessage, userMessage2, agentMessage])
      agent = await Agent.create(testAgent)
      conversation.agents.push(agent)

      await conversation.save()
      await agent.start()

      const response = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentCreateRequest)

      createdExperiment = response.body
    })

    test('should return 200 and run experiment simulation', async () => {
      const expectedResponse = {
        visible: true,
        message: 'A response',
        pause: 0
      }
      mockRespond.mockResolvedValue([expectedResponse])
      const response = await request(app)
        .post(`/v1/experiments/${createdExperiment.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalled()
      expect(response.body).toHaveProperty('name', experimentCreateRequest.name)
      expect(response.body).toHaveProperty('description', experimentCreateRequest.description)
      expect(response.body.baseConversation).toEqual(conversation.id.toString())
      expect(response.body.createdBy).toEqual(registeredUser._id.toString())
      expect(response.body.resultConversation).toEqual(createdExperiment.resultConversation)
      expect(response.body.status).toEqual('completed')
      const resultConversation = await Conversation.findById(createdExperiment.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()
      // Agent response should be in messages
      expect(resultConversation!.messages).toHaveLength(3)
      const agentMsg = resultConversation!.messages.find((msg) => msg.fromAgent)
      expect(agentMsg).toBeTruthy()
      // Ensure response message is on new result conversation, not original conversation
      expect(agentMsg!.conversation).toEqual(resultConversation!._id)
      const experiment = await Experiment.findById(createdExperiment.id)
      expect(experiment).toBeTruthy()
      expect(experiment!.status).toBe('completed')
      expect(experiment!.executedAt).toBeDefined()
    })

    test('should return 200 and run experiment simulation with a simulated start time', async () => {
      const startTimeExp = await Experiment.findOne({ _id: new mongoose.Types.ObjectId(createdExperiment.id) })
      startTimeExp!.agentModifications = [
        {
          agent,
          experimentValues: {
            llmTemplates: { contribution: 'Do something bizarre' }
          },
          simulatedStartTime: new Date('2024-01-01T10:35:30Z')
        }
      ]
      await startTimeExp!.save()

      await request(app)
        .post(`/v1/experiments/${createdExperiment.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).not.toHaveBeenCalled()
      const resultConversation = await Conversation.findById(createdExperiment.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()
      // No agent response because starting before any messages were produced
      expect(resultConversation!.messages).toHaveLength(2)
      const experiment = await Experiment.findById(createdExperiment.id)
      expect(experiment).toBeTruthy()
      expect(experiment!.status).toBe('completed')
      expect(experiment!.executedAt).toBeDefined()
    })

    test('should return 200 and run experiment with no experimental values', async () => {
      const startTimeExp = await Experiment.findOne({ _id: new mongoose.Types.ObjectId(createdExperiment.id) })
      startTimeExp!.agentModifications = [
        {
          agent
        }
      ]
      await startTimeExp!.save()
      const expectedResponse = {
        visible: true,
        message: 'A response',
        pause: 0
      }

      mockRespond.mockResolvedValue([expectedResponse])
      await request(app)
        .post(`/v1/experiments/${createdExperiment.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalled()
      const resultConversation = await Conversation.findById(createdExperiment.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()
      expect(resultConversation!.messages).toHaveLength(3)
      const experiment = await Experiment.findById(createdExperiment.id)
      expect(experiment).toBeTruthy()
      expect(experiment!.status).toBe('completed')
      expect(experiment!.executedAt).toBeDefined()
    })

    test('should return 404 for non-existent experiment', async () => {
      const nonExistentId = new mongoose.Types.ObjectId()

      await request(app)
        .post(`/v1/experiments/${nonExistentId}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.NOT_FOUND)
    })
    test('should return 400 for an experiment that has already run', async () => {
      const experiment = await Experiment.findOne({ _id: new mongoose.Types.ObjectId(createdExperiment.id) })
      experiment!.status = 'completed'
      await experiment!.save()
      await request(app)
        .post(`/v1/experiments/${createdExperiment.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.BAD_REQUEST)
    })
    test('should return 500 and set status to failed if error occurs during run', async () => {
      mockRespond.mockRejectedValue(new Error('Something went wrong'))
      await request(app)
        .post(`/v1/experiments/${createdExperiment.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.INTERNAL_SERVER_ERROR)
      const experiment = await Experiment.findOne({ _id: new mongoose.Types.ObjectId(createdExperiment.id) })
      expect(experiment).toBeTruthy()
      expect(experiment!.status).toEqual('failed')
    })
  })
  describe('GET /v1/experiments/:id', () => {
    test('should return 200 and experiment details', async () => {
      await insertUsers([registeredUser])
      const [conversation] = await insertTestConversation()
      const agent = await Agent.create(testAgent)
      await agent.save()
      conversation.agents.push(agent)
      await conversation.save()

      // Create experiment first
      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentCreateRequest)
        .expect(httpStatus.CREATED)

      // Then fetch it
      const getResponse = await request(app)
        .get(`/v1/experiments/${createResponse.body.id}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(getResponse.body).toHaveProperty('name', experimentCreateRequest.name)
      expect(getResponse.body).toHaveProperty('description', experimentCreateRequest.description)
      expect(getResponse.body).toHaveProperty('baseConversation')
      expect(getResponse.body).toHaveProperty('resultConversation')
      expect(getResponse.body).toHaveProperty('status', 'not started')
      expect(getResponse.body.createdBy).toEqual(registeredUser._id.toString())
      expect(getResponse.body).toHaveProperty('agentModifications')
    })

    test('should return 404 for non-existent experiment', async () => {
      await insertUsers([registeredUser])

      await request(app)
        .get(`/v1/experiments/${new mongoose.Types.ObjectId()}`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.NOT_FOUND)
    })
  })
  describe('POST /v1/experiments/:id/results', () => {
    let completedExperiment
    let resultConversation

    beforeEach(async () => {
      userOne.pseudonyms = [
        {
          _id: new mongoose.Types.ObjectId(),
          token:
            '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
          pseudonym: 'Fearful Frog',
          active: 'true'
        }
      ]

      await insertUsers([userOne, registeredUser])
      const [conversation] = await insertTestConversation()

      // Create and run an experiment
      const agent = await Agent.create(testAgent)
      conversation.agents.push(agent)

      const agent2 = await Agent.create(testTextAgent)
      conversation.agents.push(agent2)

      await conversation.save()

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentCreateRequest)
        .expect(httpStatus.CREATED)

      // Set up completed experiment with result conversation
      const experiment = await Experiment.findById(createResponse.body.id)
      experiment!.status = 'completed'
      experiment!.executedAt = new Date('2024-01-01T10:00:00Z')
      await experiment!.save()

      completedExperiment = experiment
      resultConversation = await Conversation.findById(experiment!.resultConversation)

      // Add some test messages to result conversation for periodicResponses
      const moderatorMessage = {
        _id: new mongoose.Types.ObjectId(),
        conversation: resultConversation._id,
        channels: ['moderator'],
        body: {
          insights: [
            {
              value: 'Some insights data',
              comments: [
                { user: registeredUser.pseudonyms[0].pseudonym, text: 'Test participant message' },
                { user: userOne.pseudonyms[0].pseudonym, text: 'I have something to say' }
              ]
            },
            {
              value: 'Another Insight',
              comments: [{ user: registeredUser.pseudonyms[0].pseudonym, text: 'Test participant message' }]
            }
          ],
          timestamp: {
            start: new Date('2024-01-01T10:00:00Z'),
            end: new Date('2024-01-01T10:30:00Z')
          }
        },
        bodyType: 'json',
        fromAgent: true,
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z'),
        pseudonym: testAgent.pseudonyms[0].pseudonym,
        pseudonymId: testAgent.pseudonyms[0]._id
      }

      const otherAgentMessage = {
        _id: new mongoose.Types.ObjectId(),
        conversation: resultConversation._id,
        body: 'Hello There',
        fromAgent: true,
        createdAt: new Date('2024-01-01T10:08:00Z'),
        updatedAt: new Date('2024-01-01T10:08:00Z'),
        pseudonym: testTextAgent.pseudonyms[0].pseudonym,
        pseudonymId: testTextAgent.pseudonyms[0]._id
      }

      const participantMessage = {
        _id: new mongoose.Types.ObjectId(),
        conversation: resultConversation._id,
        channels: ['participant'],
        body: { text: 'Test participant message' },
        bodyType: 'json',
        fromAgent: false,
        createdAt: new Date('2024-01-01T10:10:00Z'),
        updatedAt: new Date('2024-01-01T10:10:00Z'),
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id
      }

      const participantMessage2 = {
        _id: new mongoose.Types.ObjectId(),
        conversation: resultConversation._id,
        channels: ['participant'],
        body: { text: 'Another test participant message' },
        bodyType: 'json',
        fromAgent: false,
        createdAt: new Date('2024-01-01T09:50:00Z'),
        updatedAt: new Date('2024-01-01T09:50:00Z'),
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id
      }

      const participantMessage3 = {
        _id: new mongoose.Types.ObjectId(),
        conversation: resultConversation._id,
        channels: ['participant'],
        body: { text: 'I have something to say' },
        bodyType: 'json',
        fromAgent: false,
        createdAt: new Date('2024-01-01T10:15:00Z'),
        updatedAt: new Date('2024-01-01T10:15:00Z'),
        pseudonym: userOne.pseudonyms[0].pseudonym,
        pseudonymId: userOne.pseudonyms[0]._id
      }

      await Message.create([
        moderatorMessage,
        participantMessage,
        participantMessage2,
        participantMessage3,
        otherAgentMessage
      ])
    })

    describe('periodicResponses report', () => {
      test('should return 200 and generate periodicResponses report from agents with JSON and String responses in text format', async () => {
        const response = await request(app)
          .get(`/v1/experiments/${completedExperiment._id}/results`)
          .query({
            reportName: 'periodicResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')

        const experimentDate = new Date('2024-01-01T10:00:00Z')
        const msg2Time = new Date('2024-01-01T09:50:00Z') // participantMessage2
        const msg1Time = new Date('2024-01-01T10:10:00Z') // participantMessage
        const msg3Time = new Date('2024-01-01T10:15:00Z') // participantMessage3
        const agentStartTime = new Date('2024-01-01T10:03:00Z') // testTextAgent response time - 5 seconds
        const agentResponseTime = new Date('2024-01-01T10:08:00Z') // testTextAgent response
        const insightsStartTime = new Date('2024-01-01T10:00:00Z') // start time from insights
        const insightsEndTime = new Date('2024-01-01T10:30:00Z') // end time from insights

        const expectedReport = `Periodic Agent Responses Report
===========================

Experiment: Test Experiment
Description: A test experiment to validate functionality
Experiment Time: ${formatDate(experimentDate)}
Base Conversation ID: ${completedExperiment.baseConversation._id}
Result Conversation ID: ${completedExperiment.resultConversation._id}
Unique Participants: 2

===========================
Agent Name: Test Agent


***Messages in time period: No timestamp - ${formatTime(insightsStartTime)}***

${formatTime(msg2Time)}  Boring Badger: Another test participant message



***Messages in time period: ${formatTime(insightsStartTime)} - ${formatTime(insightsEndTime)}***

${formatTime(msg1Time)}  Boring Badger: Test participant message

${formatTime(msg3Time)}  Fearful Frog: I have something to say


**Agent Responses**

  Insights:

      Value: Some insights data
      Comments:

          User: Boring Badger
          Text: Test participant message

          User: Fearful Frog
          Text: I have something to say

      Value: Another Insight
      Comments:

          User: Boring Badger
          Text: Test participant message


***Messages from: ${formatTime(insightsEndTime)} onwards***



===========================
Agent Name: Test Text Agent


***Messages in time period: No timestamp - ${formatTime(agentStartTime)}***

${formatTime(msg2Time)}  Boring Badger: Another test participant message



***Messages in time period: ${formatTime(agentStartTime)} - ${formatTime(agentResponseTime)}***


**Agent Responses**

  Value: Hello There


***Messages from: ${formatTime(agentResponseTime)} onwards***

${formatTime(msg1Time)}  Boring Badger: Test participant message

${formatTime(msg3Time)}  Fearful Frog: I have something to say



`

        expect(response.text).toEqual(expectedReport)
      })

      test('should default to text format when format not specified', async () => {
        const response = await request(app)
          .get(`/v1/experiments/${completedExperiment._id}/results`)
          .query({
            reportName: 'periodicResponses'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
      })

      test('should return 404 for non-existent experiment', async () => {
        const nonExistentId = new mongoose.Types.ObjectId().toString()
        await request(app)
          .get(`/v1/experiments/${nonExistentId}/results`)
          .query({
            reportName: 'periodicResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)

          .expect(httpStatus.NOT_FOUND)
      })

      test('should return 400 for unknown report name', async () => {
        await request(app)
          .get(`/v1/experiments/${completedExperiment._id}/results`)
          .query({
            reportName: 'unknownReport',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.BAD_REQUEST)
      })

      test('should return 400 when format not supported', async () => {
        await request(app)
          .get(`/v1/experiments/${completedExperiment._id}/results`)
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .query({
            reportName: 'periodicResponses',
            format: 'xml'
          })
          .expect(httpStatus.BAD_REQUEST)
      })

      test('should handle missing reportName in request body', async () => {
        await request(app)
          .get(`/v1/experiments/${completedExperiment._id}/results`)
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .query({
            format: 'text'
            // missing reportName
          })
          .expect(httpStatus.BAD_REQUEST)
      })
    })
    describe('directMessageResponses report', () => {
      let directMessageExperiment
      let directMessageConversation
      let msg1Time
      let msg2Time
      let msg3Time
      let msg4Time
      let msg5Time
      let msg6Time
      let msg7Time

      beforeEach(async () => {
        // Create a dedicated conversation for direct message testing
        const directMessageConversationId = new mongoose.Types.ObjectId()
        const testDirectMessageConversation = {
          _id: directMessageConversationId,
          name: 'Direct Message Test Conversation',
          topic: publicTopic._id,
          description: 'A test conversation for direct message experiments',
          messages: [],
          owner: registeredUser._id,
          createdAt: new Date('2024-01-01T10:00:00Z'),
          updatedAt: new Date('2024-01-01T12:00:00Z')
        }

        const [conversation] = await insertConversations([testDirectMessageConversation])
        directMessageConversation = conversation

        // Create agents for direct message testing
        const dmAgent1 = await Agent.create({
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation,
          agentType: 'test',
          pseudonyms: [
            {
              _id: new mongoose.Types.ObjectId(),
              token:
                '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
              pseudonym: 'DMTestAgent1',
              active: 'true'
            }
          ]
        })

        const dmAgent2 = await Agent.create({
          _id: new mongoose.Types.ObjectId(),
          agentType: 'testText',
          conversation: directMessageConversation,
          pseudonyms: [
            {
              _id: new mongoose.Types.ObjectId(),
              token:
                '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
              pseudonym: 'DMTestAgent2',
              active: 'true'
            }
          ]
        })

        directMessageConversation.agents.push(dmAgent1, dmAgent2)
        await directMessageConversation.save()

        // Create direct message channels
        await Channel.create({
          name: 'direct_dmagent1_user1',
          direct: true,
          participants: [dmAgent1._id, registeredUser._id]
        })

        await Channel.create({
          name: 'direct_dmagent1_user2',
          direct: true,
          participants: [dmAgent1._id, userOne._id]
        })

        await Channel.create({
          name: 'direct_dmagent2_user1',
          direct: true,
          participants: [dmAgent2._id, registeredUser._id]
        })

        // Add direct message conversations
        msg1Time = new Date('2024-01-01T10:05:00Z')
        const directMessage1 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent1_user1'],
          body: 'Hello agent, can you help me?',
          fromAgent: false,
          createdAt: msg1Time,
          updatedAt: msg1Time,
          pseudonym: registeredUser.pseudonyms[0].pseudonym,
          pseudonymId: registeredUser.pseudonyms[0]._id
        }

        msg2Time = new Date('2024-01-01T10:06:00Z')
        const directMessage2 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent1_user1'],
          body: 'Sure, I can help you with that.',
          fromAgent: true,
          createdAt: msg2Time,
          updatedAt: msg2Time,
          pseudonym: dmAgent1.pseudonyms[0].pseudonym,
          pseudonymId: dmAgent1.pseudonyms[0]._id
        }

        msg3Time = new Date('2024-01-01T10:07:00Z')
        const directMessage3 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent1_user1'],
          body: 'Thank you for the help!',
          fromAgent: false,
          createdAt: msg3Time,
          updatedAt: msg3Time,
          pseudonym: registeredUser.pseudonyms[0].pseudonym,
          pseudonymId: registeredUser.pseudonyms[0]._id
        }

        msg4Time = new Date('2024-01-01T10:08:00Z')
        const directMessage4 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent1_user2'],
          body: 'I need assistance too',
          fromAgent: false,
          createdAt: msg4Time,
          updatedAt: msg4Time,
          pseudonym: userOne.pseudonyms[0].pseudonym,
          pseudonymId: userOne.pseudonyms[0]._id
        }

        msg5Time = new Date('2024-01-01T10:09:00Z')
        const directMessage5 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent1_user2'],
          body: 'Of course, what do you need?',
          fromAgent: true,
          createdAt: msg5Time,
          updatedAt: msg5Time,
          pseudonym: dmAgent1.pseudonyms[0].pseudonym,
          pseudonymId: dmAgent1.pseudonyms[0]._id
        }

        msg6Time = new Date('2024-01-01T10:10:00Z')
        const directMessage6 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent2_user1'],
          body: 'Hi there!',
          fromAgent: false,
          createdAt: msg6Time,
          updatedAt: msg6Time,
          pseudonym: registeredUser.pseudonyms[0].pseudonym,
          pseudonymId: registeredUser.pseudonyms[0]._id
        }

        msg7Time = new Date('2024-01-01T10:11:00Z')
        const directMessage7 = {
          _id: new mongoose.Types.ObjectId(),
          conversation: directMessageConversation!._id,
          channels: ['direct_dmagent2_user1'],
          body: 'Hello! How can I help?',
          fromAgent: true,
          createdAt: msg7Time,
          updatedAt: msg7Time,
          pseudonym: dmAgent2.pseudonyms[0].pseudonym,
          pseudonymId: dmAgent2.pseudonyms[0]._id
        }

        await Message.create([
          directMessage1,
          directMessage2,
          directMessage3,
          directMessage4,
          directMessage5,
          directMessage6,
          directMessage7
        ])
        // Create experiment for direct messages
        const dmExperimentRequest = {
          name: 'Direct Message Test Experiment',
          description: 'A test experiment for direct message functionality',
          baseConversation: directMessageConversation._id.toString(),
          executedAt: '2024-01-01T10:00:00Z'
        }

        const createResponse = await request(app)
          .post('/v1/experiments')
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .send(dmExperimentRequest)
          .expect(httpStatus.CREATED)
        directMessageExperiment = await Experiment.findById(createResponse.body.id)
      })

      test('should return 200 and generate directMessageResponses report in text format', async () => {
        const response = await request(app)
          .get(`/v1/experiments/${directMessageExperiment._id}/results`)
          .query({
            reportName: 'directMessageResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
        const expectedReport = `Direct Message Agent Responses Report
===========================

Experiment: Direct Message Test Experiment
Description: A test experiment for direct message functionality
Experiment Time: ${formatDate(directMessageExperiment.executedAt)}
Base Conversation ID: ${directMessageExperiment.baseConversation._id}
Result Conversation ID: ${directMessageExperiment.resultConversation._id}

===========================
Agent Name: Test Agent
Total Users Messaged: 2
Total Users Responded: 2
Min Engagements Per User: 1
Max Engagements Per User: 2
Average Engagements Per User: 1.5

---------------------------
**User: Boring Badger**

${formatTime(msg1Time)}  Boring Badger: Hello agent, can you help me?

${formatTime(msg2Time)}  DMTestAgent1: Sure, I can help you with that.

${formatTime(msg3Time)}  Boring Badger: Thank you for the help!

---------------------------
---------------------------
**User: Fearful Frog**

${formatTime(msg4Time)}  Fearful Frog: I need assistance too

${formatTime(msg5Time)}  DMTestAgent1: Of course, what do you need?

---------------------------
===========================
===========================
Agent Name: Test Text Agent
Total Users Messaged: 1
Total Users Responded: 1
Min Engagements Per User: 1
Max Engagements Per User: 1
Average Engagements Per User: 1

---------------------------
**User: Boring Badger**

${formatTime(msg6Time)}  Boring Badger: Hi there!

${formatTime(msg7Time)}  DMTestAgent2: Hello! How can I help?

---------------------------
===========================
`

        // Check that the report contains expected content
        expect(response.text).toEqual(expectedReport)
      })

      test('should handle agent with no direct message interactions', async () => {
        const dmResultConversation = await Conversation.findById(directMessageExperiment.resultConversation)

        // Remove all human messages from direct channels to test empty case
        await Message.deleteMany({
          conversation: dmResultConversation!._id,
          channels: { $in: ['direct_dmagent1_user1', 'direct_dmagent1_user2', 'direct_dmagent2_user1'] },
          fromAgent: false
        })

        const response = await request(app)
          .get(`/v1/experiments/${directMessageExperiment._id}/results`)
          .query({
            reportName: 'directMessageResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        expect(response.text).toContain('Direct Message Agent Responses Report')
        expect(response.text).toContain('Direct Message Test Experiment')
        // Should not contain agent sections since no human messages exist
        expect(response.text).not.toContain('Agent Name: Test Agent')
        expect(response.text).not.toContain('Agent Name: Test Text Agent')
      })

      test('should calculate engagement statistics correctly', async () => {
        const response = await request(app)
          .get(`/v1/experiments/${directMessageExperiment._id}/results`)
          .query({
            reportName: 'directMessageResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        // Agent 1
        expect(response.text).toContain('Total Users Messaged: 2')
        expect(response.text).toContain('Total Users Responded: 2')
        expect(response.text).toContain('Min Engagements Per User: 1')
        expect(response.text).toContain('Max Engagements Per User: 2')
        expect(response.text).toContain('Average Engagements Per User: 1.5')

        // Agent 2
        expect(response.text).toContain('Total Users Messaged: 1')
        expect(response.text).toContain('Total Users Responded: 1')
        expect(response.text).toContain('Max Engagements Per User: 1')
        expect(response.text).toContain('Average Engagements Per User: 1')
      })

      test('should only include channels where humans sent messages', async () => {
        const dmResultConversation = await Conversation.findById(directMessageExperiment.resultConversation)

        // Create an additional direct channel with only agent messages
        await Channel.create({
          name: 'direct_dmagent1_user3',
          direct: true,
          participants: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
        })

        const agentOnlyMessage = {
          _id: new mongoose.Types.ObjectId(),
          conversation: dmResultConversation!._id,
          channels: ['direct_dmagent1_user3'],
          body: 'This is an agent-only message',
          fromAgent: true,
          createdAt: new Date('2024-01-01T10:12:00Z'),
          updatedAt: new Date('2024-01-01T10:12:00Z'),
          pseudonym: 'DMTestAgent1',
          pseudonymId: new mongoose.Types.ObjectId()
        }

        await Message.create(agentOnlyMessage)

        const response = await request(app)
          .get(`/v1/experiments/${directMessageExperiment._id}/results`)
          .query({
            reportName: 'directMessageResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        // Should not include the agent-only channel in the report
        expect(response.text).not.toContain('This is an agent-only message')
        // Should still show correct participant count (not including agent-only channel)
        expect(response.text).toContain('Total Users Messaged: 2')
      })

      test('should handle experiment with no direct message channels', async () => {
        const dmResultConversation = await Conversation.findById(directMessageExperiment.resultConversation)

        // Remove all direct channels and messages
        await Channel.deleteMany({
          name: { $in: ['direct_dmagent1_user1', 'direct_dmagent1_user2', 'direct_dmagent2_user1'] }
        })
        await Message.deleteMany({
          conversation: dmResultConversation!._id,
          channels: { $in: ['direct_dmagent1_user1', 'direct_dmagent1_user2', 'direct_dmagent2_user1'] }
        })

        const response = await request(app)
          .get(`/v1/experiments/${directMessageExperiment._id}/results`)
          .query({
            reportName: 'directMessageResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        expect(response.text).toContain('Direct Message Agent Responses Report')
        expect(response.text).toContain('Direct Message Test Experiment')
        // Should not contain any agent sections
        expect(response.text).not.toContain('Agent Name:')
      })

      test('should default to text format when format not specified', async () => {
        const response = await request(app)
          .get(`/v1/experiments/${directMessageExperiment._id}/results`)
          .query({
            reportName: 'directMessageResponses'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.OK)

        expect(response.headers['content-type']).toBe('text/plain; charset=utf-8')
        expect(response.text).toContain('Direct Message Agent Responses Report')
      })

      test('should return 404 for non-existent experiment', async () => {
        const nonExistentId = new mongoose.Types.ObjectId().toString()
        await request(app)
          .get(`/v1/experiments/${nonExistentId}/results`)
          .query({
            reportName: 'directMessageResponses',
            format: 'text'
          })
          .set('Authorization', `Bearer ${registeredUserAccessToken}`)
          .expect(httpStatus.NOT_FOUND)
      })
    })
  })

  describe('Generic agent experiments', () => {
    let conversation
    let genericAgent

    beforeEach(async () => {
      await insertUsers([registeredUser])
      ;[conversation] = await insertTestConversation()
      await insertMessages([userMessage, userMessage2])
      genericAgent = await Agent.create(testGenericAgent)
      conversation.agents.push(genericAgent)

      await conversation.save()
      await genericAgent.start()
    })

    test('should run experiment with custom prompt template', async () => {
      const customTemplate = `You are a weather forecaster. Always respond with today's weather forecast.

      Reference materials:
      * Topic: {topic}
      * Conversation History: {convHistory}

      Answer:`

      const experimentRequest = {
        name: 'Weather Forecast Experiment',
        description: 'Testing generic agent with custom weather prompt',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: genericAgentId,
            experimentValues: {
              name: 'Weather Forecast Agent',
              description: 'A weather forecasting agent',
              llmTemplates: { main: customTemplate }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: 'Today will be partly cloudy with a high of 72°F and a low of 58°F.',
        channels: conversation.channels.filter((channel) => channel.name === 'moderator'),
        explanation: 'Provided weather forecast',
        action: AgentMessageActions.CONTRIBUTE
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalled()

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()
      expect(resultConversation!.messages).toHaveLength(3) // 2 user messages + 1 agent response

      const agentMsg = resultConversation!.messages.find((msg) => msg.fromAgent)
      expect(agentMsg).toBeTruthy()
      expect(agentMsg!.body).toBe('Today will be partly cloudy with a high of 72°F and a low of 58°F.')
    })

    test('should run experiment with structured output schema', async () => {
      const customTemplate = `You are a restaurant recommendation system.
      Please provide restaurant recommendations with details.

      The agent outputs these properties:
      * explanation: A short explanation of what was done
      * message: A JSON object with properties:
        - name: string (restaurant name)
        - cuisine: string
        - rating: number (1-5)
      * visible: true
      * channels: ["moderator"]
      * action: 2 (CONTRIBUTE)

      Reference materials:
      * Topic: {topic}
      * Conversation History: {convHistory}

      Answer:`

      const experimentRequest = {
        name: 'Restaurant Recommendation Experiment',
        description: 'Testing generic agent with structured output',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: genericAgentId,
            experimentValues: {
              llmTemplates: { main: customTemplate },
              agentConfig: {
                outputSchema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    cuisine: { type: 'string' },
                    rating: { type: 'number' }
                  }
                }
              }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: {
          name: 'Delicious Bistro',
          cuisine: 'French',
          rating: 4.5
        },
        channels: conversation.channels.filter((channel) => channel.name === 'moderator'),
        explanation: 'Provided restaurant recommendation',
        action: AgentMessageActions.CONTRIBUTE
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalled()

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()
      expect(resultConversation!.messages).toHaveLength(3)

      const agentMsg = resultConversation!.messages.find((msg) => msg.fromAgent)
      expect(agentMsg).toBeTruthy()
      expect(typeof agentMsg!.body).toBe('object')
      expect(agentMsg!.body).toHaveProperty('name', 'Delicious Bistro')
      expect(agentMsg!.body).toHaveProperty('cuisine', 'French')
      expect(agentMsg!.body).toHaveProperty('rating', 4.5)
    })

    test('should run experiment with invisible agent response', async () => {
      const customTemplate = `You are a silent monitoring agent that analyzes conversations.
      Your responses should not be visible to users.

      The agent outputs these properties:
      * explanation: A short explanation of what was done
      * message: Your analysis
      * visible: false
      * channels: ["moderator"]
      * action: 2 (CONTRIBUTE)

      Reference materials:
      * Topic: {topic}
      * Conversation History: {convHistory}

      Answer:`

      const experimentRequest = {
        name: 'Silent Monitor Experiment',
        description: 'Testing generic agent with invisible responses',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: genericAgentId,

            experimentValues: {
              llmTemplates: { main: customTemplate }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: false,
        message: 'Analyzed conversation patterns. Users are discussing technical topics.',
        channels: conversation.channels.filter((channel) => channel.name === 'moderator'),
        explanation: 'Performed silent analysis',
        action: AgentMessageActions.CONTRIBUTE
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalled()

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()

      const agentMsg = resultConversation!.messages.find((msg) => msg.fromAgent)
      expect(agentMsg).toBeTruthy()
      expect(agentMsg!.visible).toBe(false)
      expect(agentMsg!.body).toBe('Analyzed conversation patterns. Users are discussing technical topics.')
    })

    test('should run experiment with custom channel output', async () => {
      const customTemplate = `You are a moderator agent that sends messages to a specific channel.

      The agent outputs these properties:
      * explanation: A short explanation of what was done
      * message: Your moderation message
      * visible: true
      * channels: ["moderator"]
      * action: 2 (CONTRIBUTE)

      Reference materials:
      * Topic: {topic}
      * Conversation History: {convHistory}

      Answer:`

      const experimentRequest = {
        name: 'Channel Specific Experiment',
        description: 'Testing generic agent with custom channel output',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: genericAgentId,
            experimentValues: {
              llmTemplates: { main: customTemplate }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: 'This is a moderation message for the moderator channel only.',
        channels: conversation.channels.filter((channel) => channel.name === 'moderator'),
        explanation: 'Sent message to secondary channel',
        action: AgentMessageActions.CONTRIBUTE
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalled()

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()
      expect(resultConversation).toBeTruthy()

      const agentMsg = resultConversation!.messages.find((msg) => msg.fromAgent)
      expect(agentMsg).toBeTruthy()
      expect(agentMsg!.channels).toHaveLength(1)
      expect(agentMsg!.channels).toContain('moderator')
      expect(agentMsg!.body).toBe('This is a moderation message for the moderator channel only.')
    })
  })

  describe('runPerMessageExperiment functionality', () => {
    let perMessageAgent
    let perMessageAgentId
    let conversation
    let createdExperiment

    const testPerMessageAgentSpec = {
      perMessage: {
        respond: mockRespond,
        start: mockStart,
        name: 'Per Message Test Agent',
        description: 'A test agent that responds per message',
        maxTokens: 2000,
        defaultTriggers: { perMessage: { channels: ['participant'] } },
        priority: 100,
        llmTemplateVars: { main: [] },
        defaultLLMTemplates: {
          main: 'You respond to every message. Message: {lastMessage}'
        },
        defaultLLMPlatform: 'openai',
        defaultLLMModel: 'gpt-4o-mini'
      },
      perMessageDirect: {
        respond: mockRespond,
        start: mockStart,
        name: 'Per Message Direct Agent',
        description: 'A test agent that responds to direct messages',
        maxTokens: 2000,
        defaultTriggers: { perMessage: { directMessages: true } },
        priority: 100,
        llmTemplateVars: { main: [] },
        defaultLLMTemplates: {
          main: 'You respond to direct messages. Message: {lastMessage}'
        },
        defaultLLMPlatform: 'openai',
        defaultLLMModel: 'gpt-4o-mini'
      },
      perMessageTranscript: {
        respond: mockRespond,
        start: mockStart,
        name: 'Per Message Transcript Agent',
        description: 'A test agent with transcript RAG',
        maxTokens: 2000,
        defaultTriggers: { perMessage: { channels: ['transcript'] } },
        priority: 100,
        useTranscriptRAGCollection: true,
        llmTemplateVars: { main: [] },
        defaultLLMTemplates: {
          main: 'You respond using transcript data. Message: {lastMessage}'
        },
        defaultLLMPlatform: 'openai',
        defaultLLMModel: 'gpt-4o-mini'
      }
    }

    beforeAll(() => {
      setAgentTypes({ ...testAgentTypeSpecification, ...testPerMessageAgentSpec })
    })

    beforeEach(async () => {
      await insertUsers([registeredUser])
      ;[conversation] = await insertTestConversation()

      perMessageAgentId = new mongoose.Types.ObjectId()
      perMessageAgent = {
        _id: perMessageAgentId,
        conversation: conversation._id,
        agentType: 'perMessage',
        active: true,
        pseudonyms: [
          {
            _id: new mongoose.Types.ObjectId(),
            token:
              '31c5d2b7d2b0f86b2b4b204ed4bf17938e4108a573b25db493a55c4639cc6cd3518a4c88787fe29cf9f273d61e3c5fd4eabb528e3e9b7398c1ed0944581ce51e53f6eae13328c4be05e7e14365063409',
            pseudonym: 'PerMessageAgent',
            active: 'true'
          }
        ]
      }
    })

    afterAll(() => {
      setAgentTypes(defaultAgentTypes)
    })

    test('should run experiment with perMessage agent responding to all messages', async () => {
      const agent = await Agent.create(perMessageAgent)
      conversation.agents.push(agent)
      await conversation.save()

      // Create multiple messages in participant channel
      const participantMsg1 = {
        _id: new mongoose.Types.ObjectId(),
        body: 'First participant message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        fromAgent: false,
        channels: ['participant'],
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z')
      }

      const participantMsg2 = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Second participant message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        fromAgent: false,
        channels: ['participant'],
        createdAt: new Date('2024-01-01T10:35:00Z'),
        updatedAt: new Date('2024-01-01T10:35:00Z')
      }

      await insertMessages([participantMsg1, participantMsg2])

      const experimentRequest = {
        name: 'Per Message Experiment',
        description: 'Testing perMessage agent responses',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: perMessageAgentId,
            experimentValues: {}
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      createdExperiment = createResponse.body

      // Mock agent response for each message
      const expectedResponse = {
        visible: true,
        message: 'Response to participant message',
        pause: 0
      }
      mockRespond.mockResolvedValue([expectedResponse])

      const runResponse = await request(app)
        .post(`/v1/experiments/${createdExperiment.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalledTimes(2) // Should respond to both messages
      expect(runResponse.body.status).toEqual('completed')

      const resultConversation = await Conversation.findById(createdExperiment.resultConversation)
        .populate('messages')
        .exec()

      expect(resultConversation!.messages).toHaveLength(4) // 2 user + 2 agent responses
      const agentMessages = resultConversation!.messages.filter((msg) => msg.fromAgent)
      expect(agentMessages).toHaveLength(2)
    })

    test('should run experiment with perMessage agent responding only to direct messages', async () => {
      perMessageAgent.agentType = 'perMessageDirect'
      const agent = await Agent.create(perMessageAgent)
      conversation.agents.push(agent)

      // Create direct message channel
      const directChannel = await Channel.create({
        name: 'direct_agent_user',
        direct: true,
        participants: [agent._id, registeredUser._id]
      })

      const directMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Direct message to agent',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        owner: registeredUser,
        fromAgent: false,
        channels: [directChannel.name],
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z')
      }

      const regularMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Regular participant message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        owner: registeredUser,
        fromAgent: false,
        channels: ['participant'],
        createdAt: new Date('2024-01-01T10:35:00Z'),
        updatedAt: new Date('2024-01-01T10:35:00Z')
      }

      await insertMessages([directMsg, regularMsg])
      conversation.channels.push(directChannel)
      await conversation.save()

      const experimentRequest = {
        name: 'Direct Message Experiment',
        description: 'Testing perMessage agent with direct messages only',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: perMessageAgentId,
            experimentValues: {}
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: 'Response to direct message',
        pause: 0
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalledTimes(1) // Should only respond to direct message

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()

      expect(resultConversation!.messages).toHaveLength(3) // 2 original + 1 agent response
      const agentMessages = resultConversation!.messages.filter((msg) => msg.fromAgent)
      expect(agentMessages).toHaveLength(1)
    })

    test('should run experiment with perMessage agent responding to specific channels', async () => {
      const agent = await Agent.create(perMessageAgent)
      conversation.agents.push(agent)

      const participantMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Participant channel message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        fromAgent: false,
        channels: ['participant'],
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z')
      }

      const moderatorMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Moderator channel message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        fromAgent: false,
        channels: ['moderator'],
        createdAt: new Date('2024-01-01T10:35:00Z'),
        updatedAt: new Date('2024-01-01T10:35:00Z')
      }

      await insertMessages([participantMsg, moderatorMsg])

      await conversation.save()

      const experimentRequest = {
        name: 'Channel Specific Experiment',
        description: 'Testing perMessage agent with specific channels',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: perMessageAgentId,
            experimentValues: {
              triggers: { perMessage: { channels: ['participant'] } }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: 'Response to participant channel',
        pause: 0
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalledTimes(1) // Should only respond to participant channel

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()

      const agentMessages = resultConversation!.messages.filter((msg) => msg.fromAgent)
      expect(agentMessages).toHaveLength(1)
    })

    test('should run experiment with perMessage agent using transcript RAG', async () => {
      perMessageAgent.agentType = 'perMessageTranscript'
      const agent = await Agent.create(perMessageAgent)
      conversation.agents.push(agent)

      const transcriptMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Transcript content for RAG',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        fromAgent: false,
        channels: ['transcript'],
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z')
      }

      await insertMessages([transcriptMsg])

      await conversation.save()

      const experimentRequest = {
        name: 'Transcript RAG Experiment',
        description: 'Testing perMessage agent with transcript RAG collection',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: perMessageAgentId,
            experimentValues: {}
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: 'Response using transcript data',
        pause: 0
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalledTimes(1)

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()

      const agentMessages = resultConversation!.messages.filter((msg) => msg.fromAgent)
      expect(agentMessages).toHaveLength(1)
    })

    test('should run experiment with perMessage agent responding to mixed channel types', async () => {
      const agent = await Agent.create(perMessageAgent)
      conversation.agents.push(agent)

      // Create direct channel
      const directChannel = await Channel.create({
        name: 'direct_mixed_user',
        direct: true,
        participants: [agent._id, registeredUser._id]
      })

      const participantMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Participant message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        owner: registeredUser,
        fromAgent: false,
        channels: ['participant'],
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z')
      }

      const directMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Direct message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        owner: registeredUser,
        fromAgent: false,
        channels: [directChannel.name],
        createdAt: new Date('2024-01-01T10:35:00Z'),
        updatedAt: new Date('2024-01-01T10:35:00Z')
      }

      const moderatorMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Moderator message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        owner: registeredUser,
        fromAgent: false,
        channels: ['moderator'],
        createdAt: new Date('2024-01-01T10:40:00Z'),
        updatedAt: new Date('2024-01-01T10:40:00Z')
      }

      await insertMessages([participantMsg, directMsg, moderatorMsg])
      conversation.channels.push(directChannel)
      await conversation.save()

      const experimentRequest = {
        name: 'Mixed Channel Experiment',
        description: 'Testing perMessage agent with mixed channel configuration',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: perMessageAgentId,
            experimentValues: {
              triggers: {
                perMessage: {
                  channels: ['participant'],
                  directMessages: true
                }
              }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      const expectedResponse = {
        visible: true,
        message: 'Mixed response',
        pause: 0
      }
      mockRespond.mockResolvedValue([expectedResponse])

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).toHaveBeenCalledTimes(2) // participant + direct, but not moderator

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()

      const agentMessages = resultConversation!.messages.filter((msg) => msg.fromAgent)
      expect(agentMessages).toHaveLength(2)
    })

    test('should handle perMessage agent with no matching messages', async () => {
      const agent = await Agent.create(perMessageAgent)
      conversation.agents.push(agent)

      // Create message in non-matching channel
      const moderatorMsg = {
        _id: new mongoose.Types.ObjectId(),
        body: 'Moderator only message',
        conversation: conversation._id,
        createdBy: registeredUser._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        fromAgent: false,
        channels: ['moderator'],
        createdAt: new Date('2024-01-01T10:30:00Z'),
        updatedAt: new Date('2024-01-01T10:30:00Z')
      }

      await insertMessages([moderatorMsg])

      await conversation.save()

      const experimentRequest = {
        name: 'No Match Experiment',
        description: 'Testing perMessage agent with no matching messages',
        baseConversation: conversation._id.toString(),
        agentModifications: [
          {
            agent: perMessageAgentId,
            experimentValues: {
              triggers: { perMessage: { channels: ['participant'] } }
            }
          }
        ]
      }

      const createResponse = await request(app)
        .post('/v1/experiments')
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send(experimentRequest)
        .expect(httpStatus.CREATED)

      await request(app)
        .post(`/v1/experiments/${createResponse.body.id}/run`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .expect(httpStatus.OK)

      expect(mockRespond).not.toHaveBeenCalled()

      const resultConversation = await Conversation.findById(createResponse.body.resultConversation)
        .populate('messages')
        .exec()

      const agentMessages = resultConversation!.messages.filter((msg) => msg.fromAgent)
      expect(agentMessages).toHaveLength(0)
    })
  })
})
