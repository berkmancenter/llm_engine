import setupIntTest from '../utils/setupIntTest.js'
import Agent, { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import agentService from '../../src/services/agent.service/index.js'
import { insertUsers, registeredUser } from '../fixtures/user.fixture.js'
import { publicTopic, conversationAgentsEnabled } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import Conversation from '../../src/models/conversation.model.js'
import defaultAgentTypes from '../../src/agents/index.js'
import schedule from '../../src/jobs/schedule.js'
import defineJob from '../../src/jobs/define.js'

const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockInitialize = jest.fn()
const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()

const testAgentTypes = {
  manual: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    isWithinTokenLimit: mockTokenLimit,
    start: mockStart,
    stop: mockStop,
    name: 'Test Manual',
    description: 'An agent triggered manually',
    maxTokens: 2000,
    timerPeriod: undefined,
    priority: 100,
    llmTemplateVars: { template: [] },
    defaultLLMTemplates: {
      template: 'Default template'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    defaultLLMModelOptions: { prop: 'value' }
  },
  periodic: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    isWithinTokenLimit: mockTokenLimit,
    start: mockStart,
    stop: mockStop,
    name: 'Test Periodic',
    description: 'An agent that responds only periodically',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 30 } },
    priority: 200,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini'
  },
  perMessage: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    isWithinTokenLimit: mockTokenLimit,
    start: mockStart,
    stop: mockStop,
    name: 'Test Per Message',
    description: 'An agent that responds to every message',
    maxTokens: 2000,
    defaultTriggers: { perMessage: {} },
    priority: 10,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini'
  }
}
setupIntTest()
let conversation
let scheduleSpy
let definePeriodicSpy
let defineResponseSpy
let cancelSpy
describe('agent tests', () => {
  beforeAll(async () => {
    setAgentTypes(testAgentTypes)
  })
  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])

    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()
    scheduleSpy = jest.spyOn(schedule, 'periodicAgent').mockResolvedValue()
    definePeriodicSpy = jest.spyOn(defineJob, 'periodicAgent').mockResolvedValue()
    defineResponseSpy = jest.spyOn(defineJob, 'agentResponse').mockResolvedValue()
    cancelSpy = jest.spyOn(schedule, 'cancelPeriodicAgent').mockResolvedValue()
  })
  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })

  test('should create and initialize agent with no triggers', async () => {
    const agent = await agentService.createAgent('manual', conversation)
    expect(agent.conversation).toEqual(conversation)
    expect(mockInitialize).toHaveBeenCalled()
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(definePeriodicSpy).not.toHaveBeenCalled()
    expect(defineResponseSpy).toHaveBeenCalledTimes(1)
  })
  test('should create and initialize agent with per message triggers', async () => {
    const agent = await agentService.createAgent('perMessage', conversation)
    expect(agent.conversation).toEqual(conversation)
    expect(mockInitialize).toHaveBeenCalled()
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(definePeriodicSpy).not.toHaveBeenCalled()
    expect(defineResponseSpy).toHaveBeenCalledTimes(1)
  })
  test('should create and initialize agent with periodic triggers', async () => {
    const agent = await agentService.createAgent('periodic', conversation)
    expect(agent.conversation).toEqual(conversation)
    expect(mockInitialize).toHaveBeenCalled()

    // don't schedule yet because agent is inactive by default
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(definePeriodicSpy).not.toHaveBeenCalled()
    expect(defineResponseSpy).not.toHaveBeenCalled()
  })
  test('should start and activate agent with a manual trigger', async () => {
    const activateSpy = jest.spyOn(schedule, 'agentResponse').mockResolvedValue()
    const agent = new Agent({
      agentType: 'manual',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agentService.startAgent(agent)

    expect(mockStart).toHaveBeenCalled()
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(definePeriodicSpy).not.toHaveBeenCalled()
    expect(activateSpy).toHaveBeenCalledTimes(1)
  })

  test('should start and reschedule agent with a periodic trigger', async () => {
    const agent = new Agent({
      agentType: 'periodic',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agentService.startAgent(agent)

    expect(mockStart).toHaveBeenCalled()
    expect(scheduleSpy).toHaveBeenCalledTimes(1)
    expect(definePeriodicSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })
  test('should stop agent without a periodic trigger', async () => {
    const agent = new Agent({
      agentType: 'manual',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agentService.stopAgent(agent)

    expect(mockStop).toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  test('should stop agent with a periodic trigger and cancel agenda job', async () => {
    const agent = new Agent({
      agentType: 'periodic',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agentService.stopAgent(agent)

    expect(mockStop).toHaveBeenCalled()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  describe('introduceAgents', () => {
    let mockAgentIntroduction
    let agents
    let groupChannel
    let directChannel

    beforeEach(() => {
      // Mock the schedule.agentIntroduction function
      mockAgentIntroduction = jest.spyOn(schedule, 'agentIntroduction').mockResolvedValue()

      // Setup test agents
      agents = [
        { _id: 'agent1', agentType: 'manual' },
        { _id: 'agent2', agentType: 'periodic' },
        { _id: 'agent3', agentType: 'perMessage' }
      ]

      // Setup test channels
      groupChannel = {
        _id: 'channel1',
        direct: false
        // non-direct channels don't have participants set
      }

      directChannel = {
        _id: 'channel2',
        direct: true,
        participants: ['user1', 'agent1'] // exactly 2 participants: user and agent
      }
    })

    afterEach(() => {
      jest.clearAllMocks()
    })

    test('should introduce all agents in a group channel', async () => {
      await agentService.introduceAgents(agents, groupChannel)

      expect(mockAgentIntroduction).toHaveBeenCalledTimes(3)
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent1',
        channelId: 'channel1'
      })
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent2',
        channelId: 'channel1'
      })
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent3',
        channelId: 'channel1'
      })
    })

    test('should only introduce participating agents in a direct channel', async () => {
      await agentService.introduceAgents(agents, directChannel)

      // Only agent1 is a participant in this direct channel
      expect(mockAgentIntroduction).toHaveBeenCalledTimes(1)
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent1',
        channelId: 'channel2'
      })
      expect(mockAgentIntroduction).not.toHaveBeenCalledWith({
        agentId: 'agent2',
        channelId: 'channel2'
      })
      expect(mockAgentIntroduction).not.toHaveBeenCalledWith({
        agentId: 'agent3',
        channelId: 'channel2'
      })
    })

    test('should not introduce any agents in direct channel with no participating agents', async () => {
      const directChannelNoAgents = {
        _id: 'channel3',
        direct: true,
        participants: ['user1', 'user2'] // no agents in participants
      }

      await agentService.introduceAgents(agents, directChannelNoAgents)

      expect(mockAgentIntroduction).not.toHaveBeenCalled()
    })

    test('should handle empty agents array', async () => {
      await agentService.introduceAgents([], groupChannel)

      expect(mockAgentIntroduction).not.toHaveBeenCalled()
    })

    test('should handle single agent in group channel', async () => {
      const singleAgent = [{ _id: 'agent1', agentType: 'manual' }]

      await agentService.introduceAgents(singleAgent, groupChannel)

      expect(mockAgentIntroduction).toHaveBeenCalledTimes(1)
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent1',
        channelId: 'channel1'
      })
    })

    test('should handle direct channel with single participating agent', async () => {
      const singleParticipatingAgent = [{ _id: 'agent1', agentType: 'manual' }]
      const directChannelSingleAgent = {
        _id: 'channel4',
        direct: true,
        participants: ['user1', 'agent1'] // exactly 2 participants
      }

      await agentService.introduceAgents(singleParticipatingAgent, directChannelSingleAgent)

      expect(mockAgentIntroduction).toHaveBeenCalledTimes(1)
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent1',
        channelId: 'channel4'
      })
    })

    test('should handle agents with missing _id', async () => {
      const agentsWithMissingId = [
        { _id: 'agent1', agentType: 'manual' },
        { agentType: 'periodic' }, // Missing _id
        { _id: 'agent3', agentType: 'perMessage' }
      ]

      await agentService.introduceAgents(agentsWithMissingId, groupChannel)

      expect(mockAgentIntroduction).toHaveBeenCalledTimes(3)
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent1',
        channelId: 'channel1'
      })
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: undefined,
        channelId: 'channel1'
      })
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent3',
        channelId: 'channel1'
      })
    })

    test('should handle channel with empty participants array', async () => {
      const channelEmptyParticipants = {
        _id: 'channel6',
        direct: true,
        participants: []
      }

      await agentService.introduceAgents(agents, channelEmptyParticipants)

      expect(mockAgentIntroduction).not.toHaveBeenCalled()
    })

    test('should handle multiple direct channels with different agents', async () => {
      const directChannel1 = {
        _id: 'channel7',
        direct: true,
        participants: ['user1', 'agent1']
      }

      const directChannel2 = {
        _id: 'channel8',
        direct: true,
        participants: ['user2', 'agent2']
      }

      await agentService.introduceAgents(agents, directChannel1)
      await agentService.introduceAgents(agents, directChannel2)

      expect(mockAgentIntroduction).toHaveBeenCalledTimes(2)
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent1',
        channelId: 'channel7'
      })
      expect(mockAgentIntroduction).toHaveBeenCalledWith({
        agentId: 'agent2',
        channelId: 'channel8'
      })
    })
  })
})
