import faker from 'faker'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import { Message, Conversation, Agent, Channel } from '../../src/models/index.js'
import { registeredUser, insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic, conversationAgentsEnabled } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { AgentMessageActions } from '../../src/types/index.types.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'

jest.setTimeout(120000)
const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
const mockInitialize = jest.fn()
// const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockIntroduce = jest.fn()

const testAgentTypes = {
  perMessageWithMin: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
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
    defaultConversationHistorySettings: { timeWindow: 45 },
    useTranscriptRAGCollection: true
  },
  periodic: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Periodic',
    description: 'An agent that responds only periodically',
    maxTokens: 2000,
    defaultTriggers: { perMessage: { periodic: { timerPeriod: 30 } } },
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
    defaultLLMModel: 'gpt-4o-mini',
    defaultConversationHistorySettings: { directMessages: true }
  },

  withParsers: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Agent With Parsers',
    description: 'An agent that parses input and output',
    maxTokens: 2000,
    defaultTriggers: { periodic: { timerPeriod: 300 } },
    priority: 10,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    parseInput: (msg) => {
      const translatedMsg = { ...msg }
      translatedMsg.bodyType = 'json'
      translatedMsg.body = { text: msg.body }
      return translatedMsg
    },
    parseOutput: (msg) => {
      if (msg.bodyType === 'text') {
        return msg
      }
      const translatedMsg = { ...msg }
      translatedMsg.bodyType = 'text'
      translatedMsg.body = `**${msg.body.insights.join('\n')}**`
      return translatedMsg
    }
  },
  withParsersPerMessage: {
    initialize: mockInitialize,
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Agent With Parsers Per Message',
    description: 'An agent that parses input and output per message',
    maxTokens: 2000,
    defaultTriggers: { perMessage: {} },
    priority: 10,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform: 'openai',
    defaultLLMModel: 'gpt-4o-mini',
    parseInput: (msg) => {
      const translatedMsg = { ...msg }
      translatedMsg.bodyType = 'json'
      translatedMsg.body = { text: msg.body }
      return translatedMsg
    },
    parseOutput: (msg) => {
      if (msg.bodyType === 'text') {
        return msg
      }
      const translatedMsg = { ...msg }
      translatedMsg.bodyType = 'text'
      translatedMsg.body = `**${msg.body.insights.join('\n')}**`
      return translatedMsg
    }
  }
}

setupIntTest()

let conversation
let msg1
let msg2
let msg3
describe('agent tests', () => {
  beforeAll(async () => {
    setAgentTypes(testAgentTypes)
  })
  beforeEach(async () => {
    await insertUsers([registeredUser])
    await insertTopics([publicTopic])

    conversation = new Conversation(conversationAgentsEnabled)
    await conversation.save()

    msg1 = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: faker.lorem.words(10),
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym
    })
    msg2 = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: faker.lorem.words(10),
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym
    })
    msg3 = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: faker.lorem.words(10),
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym
    })
  })
  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })
  afterEach(async () => {
    jest.clearAllMocks()
  })

  test('should set default values from agent type', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation
    })
    await agent.save()

    expect(agent.llmTemplates!.template).toBe('Default template')
    expect(agent.llmTemplateVars!.template).toHaveLength(0)
    expect(agent.llmModel).toBe('gpt-4o-mini')
    expect(agent.llmPlatform).toBe('openai')
    expect(agent.llmModelOptions!.prop).toBe('value')
    expect(agent.triggers).toBe(testAgentTypes.perMessageWithMin.defaultTriggers)
    expect(agent.conversationHistorySettings).toBe(testAgentTypes.perMessageWithMin.defaultConversationHistorySettings)
    expect(agent.useTranscriptRAGCollection).toBe(true)
  })

  test('should introduce itself on a specified channel', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation,
      active: true
    })

    const directChannel = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'dm-user1-user2',
      participants: [registeredUser._id, agent._id],
      direct: true
    })
    await agent.save()
    await agent.initialize()

    const expectedResponse = {
      visible: true,
      message: 'Hello, I am an agent'
    }
    mockIntroduce.mockResolvedValue([expectedResponse])

    const introductions = await agent.introduce(directChannel)
    expect(introductions).toHaveLength(1)
    expect(introductions[0]).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'Hello, I am an agent',
        conversation,
        fromAgent: true
      })
    )
    expect(introductions[0].channels).toHaveLength(1)
    expect(introductions[0].channels![0]).toEqual(directChannel)
  })

  test('should not introduce itself if not active', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation,
      active: false
    })

    const directChannel = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'dm-user1-user2',
      participants: [registeredUser._id, agent._id],
      direct: true
    })
    await agent.save()
    await agent.initialize()

    const introductions = await agent.introduce(directChannel)
    expect(mockIntroduce).not.toHaveBeenCalled()
    expect(introductions).toHaveLength(0)
  })
  test('should return an empty array if agent type has no introduce method', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation,
      active: true
    })
    const directChannel = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'dm-user1-user2',
      participants: [registeredUser._id, agent._id],
      direct: true
    })
    await agent.save()
    await agent.initialize()

    const introductions = await agent.introduce(directChannel)
    expect(introductions).toHaveLength(0)
  })

  test('should start and stop an agent and not allow processing when stopped', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation,
      active: true
    })
    await agent.save()
    await agent.initialize()

    expect(mockInitialize).toHaveBeenCalled()

    // stop the agent and ensure no processing
    await agent.stop()
    expect(agent.active).toBe(false)
    expect(mockStop).toHaveBeenCalled()
    const evalNoOp = await agent.evaluate(msg1)
    expect(mockEvaluate).not.toHaveBeenCalled()
    expect(evalNoOp).not.toBeDefined()
    const responseNoOp = await agent.respond(msg1)
    expect(mockRespond).not.toHaveBeenCalled()
    expect(responseNoOp).toEqual([])

    // start the agent and ensure processing
    await agent.start()
    expect(agent.active).toBe(true)
    expect(mockStart).toHaveBeenCalled()
    const evaluation = await agent.evaluate(msg1)

    expect(evaluation).toEqual({ action: AgentMessageActions.OK, userContributionVisible: true })

    await msg1.save()

    await conversation.populate('messages')

    const expectedEval = {
      userMessage: msg2,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    const expectedResponse = {
      visible: true,
      message: 'A response',
      pause: 0
    }

    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])
    const evaluation2 = await agent.evaluate(msg2)
    expect(evaluation2).toEqual(expectedEval)
    const responses = await agent.respond(msg2)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'A response',
        conversation,
        fromAgent: true
      })
    )
    expect(responses[0].pause).toBe(0)
  })

  test('should be inactive by default', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation
    })
    await agent.save()
    await agent.initialize()

    expect(mockInitialize).toHaveBeenCalled()

    expect(agent.active).toBe(false)

    // Ensure no processing with inactive agent
    const evalNoOp = await agent.evaluate(msg1)
    expect(mockEvaluate).not.toHaveBeenCalled()
    expect(evalNoOp).not.toBeDefined()
    const responseNoOp = await agent.respond(msg1)
    expect(mockRespond).not.toHaveBeenCalled()
    expect(responseNoOp).toEqual([])

    // start the agent and ensure processing
    await agent.start()
    expect(agent.active).toBe(true)
    expect(mockStart).toHaveBeenCalled()
    const evaluation = await agent.evaluate(msg1)

    expect(evaluation).toEqual({ action: AgentMessageActions.OK, userContributionVisible: true })

    await msg1.save()

    await conversation.populate('messages')

    const expectedEval = {
      userMessage: msg2,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    const expectedResponse = {
      visible: true,
      message: 'A response',
      pause: 0
    }

    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])
    const evaluation2 = await agent.evaluate(msg2)
    expect(evaluation2).toEqual(expectedEval)
    const responses = await agent.respond(msg2)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'A response',
        conversation,
        fromAgent: true
      })
    )
    expect(responses[0].pause).toBe(0)
  })

  test('should generate an AI response when min messages received from users', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()

    expect(mockInitialize).toHaveBeenCalled()

    const evaluation = await agent.evaluate(msg1)

    expect(evaluation).toEqual({ action: AgentMessageActions.OK, userContributionVisible: true })

    // User message is persisted after agent is called and gives the OK
    await msg1.save()

    await conversation.populate('messages')

    const expectedEval = {
      userMessage: msg2,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    const expectedResponse = {
      visible: true,
      message: 'A response',
      pause: 0
    }

    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])
    const evaluation2 = await agent.evaluate(msg2)
    expect(evaluation2).toEqual(expectedEval)
    const responses = await agent.respond(msg2)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'A response',
        conversation,
        fromAgent: true
      })
    )
    expect(responses[0].pause).toBe(0)

    await msg2.save()

    await conversation.populate('messages')

    // 2 user messages and one agent message processed at this point, but agent message should not count in calculation

    const evaluation3 = await agent.evaluate(msg3)
    expect(evaluation3).toEqual({ action: AgentMessageActions.OK, userContributionVisible: true })
    expect(agent.lastActiveMessageCount).toEqual(2)
  })

  test('should generate an AI response when any messages received since last periodic check', async () => {
    const agent = new Agent({
      agentType: 'periodic',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()
    expect(mockInitialize).toHaveBeenCalled()

    await msg1.save()

    await conversation.populate('messages')

    const expectedEval = {
      userMessage: null,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    const prompt = {
      type: 'singleChoice',
      options: [
        { value: 'icecream', label: 'Ice Cream' },
        { value: 'pizza', label: 'Pizza' },
        { value: 'candy', label: 'Candy' }
      ],
      validation: { required: true }
    }

    const expectedResponse = {
      visible: true,
      message: 'Another response',
      pause: 30,
      replyFormat: prompt
    }
    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])
    const evaluation = await agent.evaluate()
    expect(evaluation).toEqual(expectedEval)

    const responses = await agent.respond()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'Another response',
        conversation,
        fromAgent: true,
        prompt
      })
    )
    expect(responses[0].pause).toBe(30)
  })

  test('should not allow agent to evaluate when no messages received since last periodic check', async () => {
    const agent = new Agent({
      agentType: 'periodic',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()
    expect(mockInitialize).toHaveBeenCalled()

    const mockEval = {
      userMessage: msg1,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: false,
      userContributionVisible: true,
      suggestion: 'Be nicer',
      contribution: undefined
    }

    mockEvaluate.mockResolvedValue(mockEval)

    await agent.evaluate(msg1)

    expect(agent.lastActiveMessageCount).toBe(1)

    await msg1.save()

    // Evaluate again - last messsage count should be one
    await agent.evaluate()
    // second evaluate should be a no-op
    expect(mockEvaluate).toHaveBeenCalledTimes(1)
  })

  test('should not increase messsage count if message rejected', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()
    expect(mockInitialize).toHaveBeenCalled()

    const expectedEval = {
      userMessage: msg1,
      action: AgentMessageActions.REJECT,
      agentContributionVisible: false,
      userContributionVisible: true,
      suggestion: 'Be nicer',
      contribution: undefined
    }

    mockEvaluate.mockResolvedValue(expectedEval)

    const evaluation = await agent.evaluate(msg1)
    expect(evaluation).toEqual(expectedEval)
    expect(agent.lastActiveMessageCount).toBe(0)

    expect(mockRespond).not.toHaveBeenCalled()
  })

  // test('should indicate if input text is within max token limit', async () => {
  //   const agent = new Agent({
  //     agentType: 'perMessage',
  //     conversation
  //   })
  //   await agent.save()
  //   mockTokenLimit.mockResolvedValue(true)

  //   await agent.initialize()

  //   const inLimit = await agent.isWithinTokenLimit('Hello')
  //   expect(inLimit).toBe(true)
  // })

  test('should set message body type to response message type', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()

    expect(mockInitialize).toHaveBeenCalled()

    const expectedEval = {
      userMessage: msg1,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    const expectedResponse = {
      visible: true,
      message: 'Test json response',
      messageType: 'json'
    }

    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])

    const evaluation = await agent.evaluate(msg1)
    expect(evaluation).toEqual(expectedEval)

    const responses = await agent.respond(msg1)
    expect(responses).toHaveLength(1)

    const response = responses[0]
    expect(response).toEqual(
      expect.objectContaining({
        visible: true,
        body: 'Test json response',
        bodyType: 'json',
        conversation,
        fromAgent: true
      })
    )
  })
  test('should not call respond if agent has settings but no conversation history', async () => {
    const agent = new Agent({
      agentType: 'withParsers',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()

    const expectedEval = {
      userMessage: null,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    mockEvaluate.mockResolvedValue(expectedEval)

    await agent.evaluate()
    await conversation.populate('messages')
    await agent.respond()

    expect(mockRespond).not.toHaveBeenCalled()
  })
  test('should pass direct channel conversation history in respond method if directMessages specified', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent.save()

    const directChannel = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'direct-agents-user1',
      participants: [registeredUser._id, agent._id],
      direct: true
    })
    conversation.channels.push(directChannel)

    const directChannel2 = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'direct-agents-user2',
      participants: [registeredUser._id, agent._id],
      direct: true
    })
    conversation.channels.push(directChannel2)
    await conversation.save()
    await agent.initialize()
    await agent.start()

    const expectedResponse = {
      visible: true,
      message: 'Test response',
      pause: 0
    }

    const expectedEval = {
      userMessage: null,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])
    msg1.channels = ['participant', 'direct-agents-user1']
    await msg1.save()

    msg3.channels = ['direct-agents-user2']
    await msg3.save()

    msg2.channels = ['participant', 'direct-agents-user2']

    await agent.evaluate(msg2)
    await msg2.save()
    await conversation.populate(['messages', 'channels'])
    await agent.respond(msg2)

    // Message 1 on a different direct channel should not be included
    expect(mockRespond.mock.calls[0][0].messages).toHaveLength(1)
    expect(mockRespond.mock.calls[0][0].messages[0].body).toEqual(msg3.body)
  })

  test('should not pass direct channel conversation history involving other agents in respond method', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent.save()

    const agent2 = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent2.save()

    const directChannel = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'direct-user1-agent2',
      participants: [registeredUser._id, agent2._id],
      direct: true
    })
    conversation.channels.push(directChannel)

    const directChannel2 = await Channel.create({
      _id: new mongoose.Types.ObjectId(),
      name: 'direct-user1-agent1',
      participants: [registeredUser._id, agent._id],
      direct: true
    })
    conversation.channels.push(directChannel2)
    await conversation.save()
    await agent.initialize()
    await agent.start()

    const expectedResponse = {
      visible: true,
      message: 'Test response',
      pause: 0
    }

    const expectedEval = {
      userMessage: null,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    mockEvaluate.mockResolvedValue(expectedEval)
    mockRespond.mockResolvedValue([expectedResponse])
    msg1.channels = ['participant', 'direct-user1-agent2']
    await msg1.save()

    msg3.channels = ['direct-user1-agent1']
    await msg3.save()

    msg2.channels = ['participant', 'direct-user1-agent1']

    await agent.evaluate(msg2)
    await msg2.save()
    await conversation.populate(['messages', 'channels'])
    await agent.respond(msg2)

    // Message 1 on a different direct channel should not be included
    expect(mockRespond.mock.calls[0][0].messages).toHaveLength(1)
    expect(mockRespond.mock.calls[0][0].messages[0].body).toEqual(msg3.body)
  })

  test('should parse input message in evaluate and respond when parseInput function is specified', async () => {
    const agent = new Agent({
      agentType: 'withParsersPerMessage',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()

    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: 'Original message body',
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym
    })

    const expectedEval = {
      userMessage: msg,
      action: AgentMessageActions.OK,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    mockEvaluate.mockResolvedValue(expectedEval)

    await agent.evaluate(msg)

    // Verify that evaluate was called with the parsed message
    const callArgs = mockEvaluate.mock.calls[0][0]
    expect(callArgs.bodyType).toBe('json')
    expect(callArgs.body).toEqual({ text: 'Original message body' })

    await agent.respond(msg)
    // Verify respond was called with the parsed message
    const respondCallArgs = mockRespond.mock.calls[0][1]
    expect(respondCallArgs.bodyType).toBe('json')
    expect(respondCallArgs.body).toEqual({ text: 'Original message body' })
  })

  test('should use original message when no parser is specified', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent.save()
    await agent.initialize()
    await agent.start()

    const msg = new Message({
      _id: new mongoose.Types.ObjectId(),
      body: 'Original message body',
      conversation: conversationAgentsEnabled._id,
      owner: registeredUser._id,
      pseudonymId: registeredUser.pseudonyms[0]._id,
      pseudonym: registeredUser.pseudonyms[0].pseudonym
    })

    const expectedEval = {
      userMessage: msg,
      action: AgentMessageActions.OK,
      agentContributionVisible: true,
      userContributionVisible: true,
      suggestion: undefined
    }

    mockEvaluate.mockResolvedValue(expectedEval)

    await agent.evaluate(msg)

    // Verify that evaluate was called with the original message (not parsed)
    const callArgs = mockEvaluate.mock.calls[0][0]
    expect(callArgs.body).toBe('Original message body')
    expect(callArgs.bodyType).toBe('text')
  })

  describe('Agent channel filtering in evaluate method', () => {
    let channelEnabledConversation
    let channel1
    let channel2
    let msgWithChannels
    let msgWithDirectChannels
    let msgWithMixedChannels
    let msgWithUnsupportedChannels

    beforeEach(async () => {
      // Create channels
      channel1 = {
        _id: new mongoose.Types.ObjectId(),
        name: 'general',
        direct: false
      }
      channel2 = {
        _id: new mongoose.Types.ObjectId(),
        name: 'random',
        direct: false
      }

      await Channel.create(channel1, channel2)

      // Create a conversation with channels
      channelEnabledConversation = new Conversation({
        ...conversationAgentsEnabled,
        channels: [channel1, channel2],
        _id: new mongoose.Types.ObjectId()
      })
      await channelEnabledConversation.save()

      // Messages with different channel configurations
      msgWithChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['general', 'random']
      })

      msgWithDirectChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-user2']
      })

      msgWithMixedChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['general', 'dm-user1-user2']
      })

      msgWithUnsupportedChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['unsupported-channel']
      })
    })

    test('should process message when channels match trigger channels', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['general', 'random']
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        userMessage: msgWithChannels,
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should process message when at least one channel matches trigger channels', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['general'] // Only general channel is in triggers
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        userMessage: msgWithChannels, // Has both 'general' and 'random', should match
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should not process message when no channels match trigger channels', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['other-channel'] // No matching channels
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        action: AgentMessageActions.OK,
        userContributionVisible: true
      }

      const evaluation = await agent.evaluate(msgWithChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).not.toHaveBeenCalled()
    })

    test('should process direct message when directMessages is enabled', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await agent.save()

      const directChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-user2',
        participants: [registeredUser._id, agent._id],
        direct: true
      })

      await agent.initialize()
      await agent.start()
      channelEnabledConversation.channels.push(directChannel)
      channelEnabledConversation.enableDMs = ['agents']
      await channelEnabledConversation.save()

      const expectedEval = {
        userMessage: msgWithDirectChannels,
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithDirectChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should not process direct message to a different agent', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await agent.save()

      const agent2 = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await agent2.save()

      const directChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-user2',
        participants: [registeredUser._id, agent2._id],
        direct: true
      })

      await agent.initialize()
      await agent.start()
      channelEnabledConversation.channels.push(directChannel)
      channelEnabledConversation.enableDMs = ['agents']
      await channelEnabledConversation.save()

      await agent.evaluate(msgWithDirectChannels)

      expect(mockEvaluate).not.toHaveBeenCalled()
    })

    test('should not process direct message when directMessages is disabled', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            directMessages: false
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        action: AgentMessageActions.OK,
        userContributionVisible: true
      }

      const evaluation = await agent.evaluate(msgWithDirectChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).not.toHaveBeenCalled()
    })

    test('should process message when it has both matching trigger channels and direct messages are enabled', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['general'],
            directMessages: true
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        userMessage: msgWithMixedChannels, // Has both 'general' and DM channel
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithMixedChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should not process message when it has only direct messages but directMessages is disabled', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['other-channel'], // No matching regular channels
            directMessages: false
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        action: AgentMessageActions.OK,
        userContributionVisible: true
      }

      const evaluation = await agent.evaluate(msgWithDirectChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).not.toHaveBeenCalled()
    })

    test('should not process message when it has only non-matching trigger channels and no direct messages', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['other-channel']
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        action: AgentMessageActions.OK,
        userContributionVisible: true
      }

      const evaluation = await agent.evaluate(msgWithUnsupportedChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).not.toHaveBeenCalled()
    })

    test('should process message with no channel when no channel triggers are defined', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {} // No channel restrictions
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const msgWithoutChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym
        // No channels property
      })

      const expectedEval = {
        userMessage: msgWithoutChannels,
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithoutChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should process message when userMessage has no channels property', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['general']
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      // Message without channels property
      const msgWithoutChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym
        // No channels property
      })

      const expectedEval = {
        userMessage: msgWithoutChannels,
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithoutChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should process message when userMessage has empty channels array', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            channels: ['general']
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      // Message with empty channels array
      const msgWithEmptyChannels = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: []
      })

      const expectedEval = {
        userMessage: msgWithEmptyChannels,
        action: AgentMessageActions.OK,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)

      const evaluation = await agent.evaluate(msgWithEmptyChannels)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).toHaveBeenCalled()
    })

    test('should handle case where conversation channel is not found in populated channels', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation,
        triggers: {
          perMessage: {
            directMessages: true
          }
        }
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const expectedEval = {
        action: AgentMessageActions.OK,
        userContributionVisible: true
      }

      // Message with a channel name that doesn't exist in conversation.channels
      const msgWithNonExistentChannel = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['non-existent-dm-channel']
      })

      const evaluation = await agent.evaluate(msgWithNonExistentChannel)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).not.toHaveBeenCalled()
    })
    test('should not process messages from other agents', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: channelEnabledConversation
      })
      await agent.save()
      await agent.initialize()
      await agent.start()

      const msgFromOtherAgent = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: faker.lorem.words(10),
        conversation: channelEnabledConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: 'Other agent',
        fromAgent: true
      })

      const expectedEval = {
        action: AgentMessageActions.OK,
        userContributionVisible: true
      }

      const evaluation = await agent.evaluate(msgFromOtherAgent)
      expect(evaluation).toEqual(expectedEval)
      expect(mockEvaluate).not.toHaveBeenCalled()
    })
  })
})
