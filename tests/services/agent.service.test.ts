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
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'

const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()

const testAgentTypes = {
  manual: {
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
    defaultLLMPlatform,
    defaultLLMModel,
    defaultLLMModelOptions: { prop: 'value' }
  },
  periodic: {
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
    defaultLLMPlatform,
    defaultLLMModel
  },
  perMessage: {
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
    defaultLLMPlatform,
    defaultLLMModel
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
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(definePeriodicSpy).not.toHaveBeenCalled()
    expect(defineResponseSpy).toHaveBeenCalledTimes(1)
  })
  test('should create and initialize agent with per message triggers', async () => {
    const agent = await agentService.createAgent('perMessage', conversation)
    expect(agent.conversation).toEqual(conversation)
    expect(scheduleSpy).not.toHaveBeenCalled()
    expect(definePeriodicSpy).not.toHaveBeenCalled()
    expect(defineResponseSpy).toHaveBeenCalledTimes(1)
  })
  test('should create and initialize agent with periodic triggers', async () => {
    const agent = await agentService.createAgent('periodic', conversation)
    expect(agent.conversation).toEqual(conversation)

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
    await await agentService.startAgent(agent)

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
    await await agentService.startAgent(agent)

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
    await await agentService.stopAgent(agent)

    expect(mockStop).toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  test('should stop agent with a periodic trigger and cancel agenda job', async () => {
    const agent = new Agent({
      agentType: 'periodic',
      conversation
    })
    await agent.save()
    await await agentService.stopAgent(agent)

    expect(mockStop).toHaveBeenCalled()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })
})
