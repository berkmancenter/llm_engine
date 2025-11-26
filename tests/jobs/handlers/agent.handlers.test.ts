import { Channel, Message, Conversation } from '../../../src/models'
import Agent, { setAgentTypes } from '../../../src/models/user.model/agent.model'
import { publicTopic, conversationAgentsEnabled } from '../../fixtures/conversation.fixture'
import { insertTopics } from '../../fixtures/topic.fixture'
import { insertUsers, registeredUser } from '../../fixtures/user.fixture'
import defaultAgentTypes from '../../../src/agents/index.js'
import JobHandlers from '../../../src/jobs/handlers/index.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'

import setupAgentTest from '../../utils/setupAgentTest.js'

jest.setTimeout(120000)
const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockInitialize = jest.fn()
const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockIntroduce = jest.fn()

const testAgentTypes = {
  perMessageWithMin: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    isWithinTokenLimit: mockTokenLimit,
    start: mockStart,
    stop: mockStop,
    introduce: mockIntroduce,
    name: 'Test Per Message Min',
    description: 'An agent that responds per message after a certain number reached',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { minNewMessages: 2 } },
    timerPeriod: undefined,
    priority: 100,
    llmTemplateVars: { template: [] },
    defaultLLMTemplates: {
      template: 'Default template'
    },
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    defaultLLMModelOptions: { prop: 'value' },
    defaultConversationHistorySettings: { timeWindow: 45 }
  }
}

setupAgentTest()
describe('agent handler tests', () => {
  let conversation
  beforeAll(async () => {
    setAgentTypes(testAgentTypes)
  })
  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])

    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()
  })
  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })
  test('should introduce agent', async () => {
    jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue()
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation
    })
    await agent.save()
    const directChannel = await Channel.create({
      name: 'dm-user1-user2',
      direct: true,
      participants: [registeredUser._id, agent._id]
    })
    conversation.channels.push(directChannel)
    await conversation.save()
    await agent.start()

    const expectedResponse = {
      visible: true,
      message: 'Hello, I am an agent'
    }
    mockIntroduce.mockResolvedValue([expectedResponse])

    await JobHandlers.agentIntroduction({ attrs: { data: { agentId: agent._id, channelId: directChannel._id } } })
    expect(mockIntroduce).toHaveBeenCalled()
    const message = await Message.findOne({ pseudonym: agent.pseudonyms[0].pseudonym })
    expect(message).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'Hello, I am an agent',
        conversation: conversation._id,
        fromAgent: true
      })
    )

    expect(message!.channels).toHaveLength(1)
    expect(message!.channels![0]).toEqual(directChannel.name)
  })
})
