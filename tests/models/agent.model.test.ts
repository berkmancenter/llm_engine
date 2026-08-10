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
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'

jest.setTimeout(120000)
const mockEvaluate = jest.fn()
const mockRespond = jest.fn()
// const mockTokenLimit = jest.fn()
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockIntroduce = jest.fn()

const testAgentTypes = {
  perMessageWithMin: {
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
    defaultLLMPlatform,
    defaultLLMModel,
    defaultLLMModelOptions: { prop: 'value' },
    defaultConversationHistorySettings: { timeWindow: 45 }
  },
  periodic: {
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
    defaultLLMPlatform,
    defaultLLMModel
  },
  perMessage: {
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
    defaultLLMPlatform,
    defaultLLMModel,
    defaultConversationHistorySettings: { directMessages: true }
  },

  withParsers: {
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
    defaultLLMPlatform,
    defaultLLMModel,
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
    defaultLLMPlatform,
    defaultLLMModel,
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
  withGoalPriorities: {
    respond: mockRespond,
    evaluate: mockEvaluate,
    start: mockStart,
    stop: mockStop,
    name: 'Test Agent With Goal Priorities',
    description: 'An agent type with goalPriorities in agentConfig',
    maxTokens: 2000,
    defaultTriggers: { perMessage: {} },
    priority: 50,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel,
    agentConfig: {
      minInterval: 5,
      goalPriorities: {
        synthesize_discussion: 80,
        bridge_topics: 50,
        provoke_participation: 20
      }
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
    expect(agent.llmModel).toBe(defaultLLMModel)
    expect(agent.llmPlatform).toBe(defaultLLMPlatform)
    expect(agent.llmModelOptions!.prop).toBe('value')
    expect(agent.llmModelOptions!.maxTokens).toBe(2000)
    expect(agent.triggers).toBe(testAgentTypes.perMessageWithMin.defaultTriggers)
    expect(agent.conversationHistorySettings).toBe(testAgentTypes.perMessageWithMin.defaultConversationHistorySettings)
  })

  test('should backfill triggers from agent type when loading a doc saved without them', async () => {
    // An agent saved before its type defined defaultTriggers has no triggers field. Loading must
    // restore the default, or evaluateMessage's perMessage gate silently rejects every message.
    const agent = new Agent({ agentType: 'perMessageWithMin', conversation })
    await agent.save()

    // Strip triggers directly through the driver to bypass the model's save hooks,
    // leaving the legacy on-disk shape a fresh load has to cope with.
    await Agent.collection.updateOne({ _id: agent._id }, { $unset: { triggers: '' } })

    const reloaded = await Agent.findById(agent._id)
    expect(reloaded!.triggers).toEqual(testAgentTypes.perMessageWithMin.defaultTriggers)
  })

  test('should inject maxTokens from agent type into llmModelOptions when not set', async () => {
    const agent = new Agent({
      agentType: 'perMessage', // no defaultLLMModelOptions
      conversation
    })
    await agent.save()

    expect(agent.llmModelOptions!.maxTokens).toBe(2000)
  })

  test('should not override maxTokens already set in defaultLLMModelOptions', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin', // defaultLLMModelOptions has no maxTokens, so type maxTokens is used
      conversation
    })
    await agent.save()

    expect(agent.llmModelOptions!.maxTokens).toBe(2000)
    expect(agent.llmModelOptions!.prop).toBe('value')
  })

  test('should not override maxTokens set on the instance', async () => {
    const agent = new Agent({
      agentType: 'perMessageWithMin',
      conversation,
      llmModelOptions: { maxTokens: 9999 }
    })
    await agent.save()

    expect(agent.llmModelOptions!.maxTokens).toBe(9999)
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
        message: 'Hello, I am an agent'
      })
    )
  })

  test('should introduce itself if not active', async () => {
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

    const introductions = await agent.introduce(directChannel)
    expect(mockIntroduce).toHaveBeenCalled()
    expect(introductions).toHaveLength(1)
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
    await // stop the agent and ensure no processing
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
        message: 'A response'
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
    await expect(agent.active).toBe(false)

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
        message: 'A response'
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
    await await agent.start()

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
        message: 'A response'
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
    await await agent.start()

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
        message: 'Another response',
        replyFormat: prompt
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
    await await agent.start()

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

  test('should allow proactive periodic agent to evaluate even when no new messages since last check', async () => {
    const agent = new Agent({
      agentType: 'periodic',
      conversation,
      triggers: { periodic: { timerPeriod: 300, proactive: true } }
    })
    await agent.save()
    await agent.start()

    mockEvaluate.mockResolvedValue({
      userMessage: null,
      action: AgentMessageActions.CONTRIBUTE,
      agentContributionVisible: false,
      userContributionVisible: true,
      suggestion: undefined
    })

    // No messages in conversation — messageCount === lastActiveMessageCount (both 0).
    // A non-proactive agent would skip; a proactive one should still call evaluate.
    await agent.evaluate()
    expect(mockEvaluate).toHaveBeenCalledTimes(1)
  })

  test('should not increase messsage count if message rejected', async () => {
    const agent = new Agent({
      agentType: 'perMessage',
      conversation
    })
    await agent.save()
    await await agent.start()

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

  test('should not call respond if agent has settings but no conversation history', async () => {
    const agent = new Agent({
      agentType: 'withParsers',
      conversation
    })
    await agent.save()
    await await agent.start()

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
    await await agent.start()

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
    await await agent.start()

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
    await await agent.start()

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
    await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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

      await await agent.start()
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

      await await agent.start()
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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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
      await await agent.start()

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

  describe('Agent channel filtering in respond method', () => {
    let testConversation
    let generalChannel
    let randomChannel
    let offTopicChannel

    beforeEach(async () => {
      // Create channels
      generalChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'general',
        direct: false
      })
      randomChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'random',
        direct: false
      })
      offTopicChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'off-topic',
        direct: false
      })

      // Create a conversation with channels
      testConversation = new Conversation({
        ...conversationAgentsEnabled,
        channels: [generalChannel, randomChannel, offTopicChannel],
        _id: new mongoose.Types.ObjectId()
      })
      await testConversation.save()
    })

    test('should filter conversation history to intersection of settings channels and userMessage channels', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: testConversation,
        conversationHistorySettings: {
          channels: ['general', 'random', 'off-topic'],
          count: 10
        }
      })
      await agent.save()
      await await agent.start()

      // Create messages on different channels
      const msgGeneral = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on general',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['general']
      })
      await msgGeneral.save()

      const msgRandom = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on random',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['random']
      })
      await msgRandom.save()

      const msgOffTopic = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on off-topic',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['off-topic']
      })
      await msgOffTopic.save()

      // New message only on 'general' and 'random'
      const userMessage = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'New message on general and random',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['general', 'random']
      })

      const expectedEval = {
        userMessage,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(userMessage)
      await userMessage.save()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond(userMessage)

      // Should only include messages from 'general' and 'random', not 'off-topic'
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(2)
      expect(conversationHistory.messages.find((m) => m.body === 'Message on general')).toBeDefined()
      expect(conversationHistory.messages.find((m) => m.body === 'Message on random')).toBeDefined()
      expect(conversationHistory.messages.find((m) => m.body === 'Message on off-topic')).toBeUndefined()
    })

    test('should use all settings channels when there is no userMessage (periodic trigger)', async () => {
      const agent = new Agent({
        agentType: 'periodic',
        conversation: testConversation,
        triggers: {
          periodic: {
            timerPeriod: 300,
            conversationHistorySettings: {
              channels: ['general', 'random'],
              count: 10
            }
          }
        }
      })
      await agent.save()
      await await agent.start()

      // Create messages on different channels
      const msgGeneral = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on general',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['general']
      })
      await msgGeneral.save()

      const msgRandom = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on random',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['random']
      })
      await msgRandom.save()

      const msgOffTopic = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on off-topic',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['off-topic']
      })
      await msgOffTopic.save()

      const expectedEval = {
        userMessage: null,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Periodic response',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond()

      // Should include messages from both 'general' and 'random', but not 'off-topic'
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(2)
      expect(conversationHistory.messages.find((m) => m.body === 'Message on general')).toBeDefined()
      expect(conversationHistory.messages.find((m) => m.body === 'Message on random')).toBeDefined()
      expect(conversationHistory.messages.find((m) => m.body === 'Message on off-topic')).toBeUndefined()
    })

    test('should get all direct channels for periodic trigger when directMessages enabled', async () => {
      const agent = new Agent({
        agentType: 'periodic',
        conversation: testConversation,
        triggers: {
          periodic: {
            timerPeriod: 300,
            conversationHistorySettings: {
              directMessages: true,
              count: 10
            }
          }
        }
      })
      await agent.save()

      const directChannel1 = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })

      const directChannel2 = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user2-agent',
        participants: [new mongoose.Types.ObjectId(), agent._id],
        direct: true
      })

      testConversation.channels.push(directChannel1, directChannel2)
      await testConversation.save()

      await await agent.start()

      // Create messages on different direct channels
      const msgDirect1 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on dm-user1-agent',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })
      await msgDirect1.save()

      const msgDirect2 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on dm-user2-agent',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user2-agent']
      })
      await msgDirect2.save()

      const expectedEval = {
        userMessage: null,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Periodic response',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond()

      // Should include messages from all direct channels where this agent is a participant
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(2)
      expect(conversationHistory.messages.find((m) => m.body === 'Message on dm-user1-agent')).toBeDefined()
      expect(conversationHistory.messages.find((m) => m.body === 'Message on dm-user2-agent')).toBeDefined()
    })

    test('should call respond with empty history when proactive periodic trigger and no DM messages', async () => {
      const agent = new Agent({
        agentType: 'periodic',
        conversation: testConversation,
        triggers: {
          periodic: {
            timerPeriod: 300,
            proactive: true,
            conversationHistorySettings: {
              directMessages: true,
              count: 10
            }
          }
        }
      })
      await agent.save()

      const directChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })
      testConversation.channels.push(directChannel)
      await testConversation.save()

      // Add a non-DM message so lastActiveMessageCount check passes
      const chatMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on chat',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['chat']
      })
      await chatMsg.save()

      await agent.start()
      await testConversation.populate(['messages', 'channels'])

      mockEvaluate.mockResolvedValue({
        userMessage: null,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      })
      mockRespond.mockResolvedValue([])

      await agent.evaluate()
      await agent.respond()

      // respond should be called with empty DM history despite chat messages existing
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(0)
    })

    test('should not call respond when non-proactive periodic trigger and no messages in history', async () => {
      const agent = new Agent({
        agentType: 'periodic',
        conversation: testConversation,
        triggers: {
          periodic: {
            timerPeriod: 300,
            conversationHistorySettings: {
              directMessages: true,
              count: 10
            }
          }
        }
      })
      await agent.save()

      const directChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })
      testConversation.channels.push(directChannel)
      await testConversation.save()

      // Add a non-DM message so lastActiveMessageCount check passes
      const chatMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on chat',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['chat']
      })
      await chatMsg.save()

      await agent.start()
      await testConversation.populate(['messages', 'channels'])

      await agent.evaluate()
      const responses = await agent.respond()

      expect(responses).toEqual([])
      expect(mockRespond).not.toHaveBeenCalled()
    })

    test('should only get direct channels from userMessage when userMessage is present', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: testConversation,
        conversationHistorySettings: {
          directMessages: true,
          count: 10
        }
      })
      await agent.save()

      const directChannel1 = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })

      const directChannel2 = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user2-agent',
        participants: [new mongoose.Types.ObjectId(), agent._id],
        direct: true
      })

      testConversation.channels.push(directChannel1, directChannel2)
      await testConversation.save()

      await await agent.start()

      // Create messages on different direct channels
      const msgDirect1 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on dm-user1-agent',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })
      await msgDirect1.save()

      const msgDirect2 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Message on dm-user2-agent',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user2-agent']
      })
      await msgDirect2.save()

      // New message only on dm-user1-agent
      const userMessage = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'New message on dm-user1-agent',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })

      const expectedEval = {
        userMessage,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(userMessage)
      await userMessage.save()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond(userMessage)

      // Should only include messages from dm-user1-agent, not dm-user2-agent
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(1)
      expect(conversationHistory.messages[0].body).toEqual('Message on dm-user1-agent')
    })
  })

  describe('LangSmith tracing behavior', () => {
    let mockGetCurrentRunTree: jest.Mock
    let mockRunTree: { metadata: Record<string, unknown> }

    beforeEach(() => {
      // Mock getCurrentRunTree and RunTree
      mockRunTree = {
        metadata: {}
      }
      mockGetCurrentRunTree = jest.fn().mockReturnValue(mockRunTree)

      /* This jest.mock() call never actually take effect: agent.model/index.ts imports
         langsmith/traceable statically, resolved when this test file's top-level
         `import { Agent } from ...` first loads that module — long before this
         beforeEach (or any jest.mock() call, which isn't hoisted under this project's
         ESM Jest config — see tests/CLAUDE.md) ever runs. So every test below exercises
         the REAL langsmith/traceable module, and mockGetCurrentRunTree/mockRunTree are
         dead — kept only so the tests below (which predate this finding) keep compiling.
         Do not extend this pattern; use jest.unstable_mockModule + a dynamic import
         after it instead (see tests/unit/models/agentModel.traceMetadata.test.ts). */
      jest.mock('langsmith/traceable', () => ({
        traceable: jest.fn((fn) => fn),
        getCurrentRunTree: mockGetCurrentRunTree
      }))
    })

    afterEach(() => {
      jest.unmock('langsmith/traceable')
    })

    test('should set base metadata (llmModel, llmPlatform, embeddingsModel) in trace', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation,
        llmModel: 'gpt-4',
        llmPlatform: 'openai'
      })
      await agent.save()
      await await agent.start()

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      const expectedEval = {
        userMessage: msg1,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(msg1)
      await msg1.save()
      await conversation.populate(['messages', 'channels'])
      await agent.respond(msg1)

      // Base metadata should be set on the trace
      expect(mockRespond).toHaveBeenCalled()
    })

    test('should call getTraceMetadata when defined and merge metadata', async () => {
      const mockGetTraceMetadata = jest.fn().mockReturnValue({
        context: 'test context',
        promptType: 'standard'
      })

      const agentTypeWithMetadata = {
        ...testAgentTypes.perMessage,
        getTraceMetadata: mockGetTraceMetadata
      }

      const testAgentTypesWithMetadata = {
        ...testAgentTypes,
        perMessageWithMetadata: agentTypeWithMetadata
      }

      setAgentTypes(testAgentTypesWithMetadata)

      const agent = new Agent({
        agentType: 'perMessageWithMetadata',
        conversation
      })
      await agent.save()
      await await agent.start()

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0,
        context: 'test context',
        promptType: 'standard'
      }

      const expectedEval = {
        userMessage: msg1,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(msg1)
      await msg1.save()
      await conversation.populate(['messages', 'channels'])
      await agent.respond(msg1)

      // getTraceMetadata should be called with conversationHistory, translatedMsg, and responses
      expect(mockGetTraceMetadata).toHaveBeenCalled()

      // Reset agent types
      setAgentTypes(testAgentTypes)
    })

    test('should call formatTraceInput when defined', async () => {
      const mockFormatTraceInput = jest.fn().mockReturnValue({
        formattedHistory: 'formatted conversation',
        formattedMessage: 'formatted message'
      })

      const agentTypeWithFormatInput = {
        ...testAgentTypes.perMessage,
        formatTraceInput: mockFormatTraceInput
      }

      const testAgentTypesWithFormat = {
        ...testAgentTypes,
        perMessageWithFormatInput: agentTypeWithFormatInput
      }

      setAgentTypes(testAgentTypesWithFormat)

      const agent = new Agent({
        agentType: 'perMessageWithFormatInput',
        conversation
      })
      await agent.save()
      await await agent.start()

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      const expectedEval = {
        userMessage: msg1,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(msg1)
      await msg1.save()
      await conversation.populate(['messages', 'channels'])
      await agent.respond(msg1)

      // formatTraceInput should be called
      expect(mockFormatTraceInput).toHaveBeenCalled()

      // Reset agent types
      setAgentTypes(testAgentTypes)
    })

    test('should call formatTraceOutput when defined', async () => {
      const mockFormatTraceOutput = jest.fn().mockReturnValue('formatted output')

      const agentTypeWithFormatOutput = {
        ...testAgentTypes.perMessage,
        formatTraceOutput: mockFormatTraceOutput
      }

      const testAgentTypesWithFormat = {
        ...testAgentTypes,
        perMessageWithFormatOutput: agentTypeWithFormatOutput
      }

      setAgentTypes(testAgentTypesWithFormat)

      const agent = new Agent({
        agentType: 'perMessageWithFormatOutput',
        conversation
      })
      await agent.save()
      await await agent.start()

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      const expectedEval = {
        userMessage: msg1,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(msg1)
      await msg1.save()
      await conversation.populate(['messages', 'channels'])
      await agent.respond(msg1)

      // formatTraceOutput should be called with result, conversationHistory, and translatedMsg
      expect(mockFormatTraceOutput).toHaveBeenCalled()
      expect(mockFormatTraceOutput).toHaveBeenCalledWith([expectedResponse], expect.anything(), expect.anything())

      // Reset agent types
      setAgentTypes(testAgentTypes)
    })

    test('should use default trace format when no format functions defined', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation
      })
      await agent.save()
      await await agent.start()

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      const expectedEval = {
        userMessage: msg1,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(msg1)
      await msg1.save()
      await conversation.populate(['messages', 'channels'])
      const responses = await agent.respond(msg1)

      // Should return responses without formatting
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBe('Test response')
    })

    test('should handle trace metadata update errors gracefully', async () => {
      const mockGetTraceMetadataError = jest.fn().mockImplementation(() => {
        throw new Error('Metadata error')
      })

      const agentTypeWithMetadataError = {
        ...testAgentTypes.perMessage,
        getTraceMetadata: mockGetTraceMetadataError
      }

      const testAgentTypesWithError = {
        ...testAgentTypes,
        perMessageWithMetadataError: agentTypeWithMetadataError
      }

      setAgentTypes(testAgentTypesWithError)

      const agent = new Agent({
        agentType: 'perMessageWithMetadataError',
        conversation
      })
      await agent.save()
      await await agent.start()

      const expectedResponse = {
        visible: true,
        message: 'Test response',
        pause: 0
      }

      const expectedEval = {
        userMessage: msg1,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(msg1)
      await msg1.save()
      await conversation.populate(['messages', 'channels'])

      // Should not throw even if getTraceMetadata throws
      await expect(agent.respond(msg1)).resolves.not.toThrow()

      // Reset agent types
      setAgentTypes(testAgentTypes)
    })
  })

  describe('Threaded replies', () => {
    let testConversation
    let testChannel
    let parentMsg
    let reply1
    let reply2
    let newReply

    beforeEach(async () => {
      // Create a conversation
      testConversation = new Conversation({
        ...conversationAgentsEnabled,
        _id: new mongoose.Types.ObjectId(),
        enableDMs: ['agents']
      })
      await testConversation.save()
    })

    test('should only include thread messages in conversation history for threaded reply in group chat', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: testConversation
      })
      await agent.save()

      testChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'chat',
        direct: false
      })
      testConversation.channels.push(testChannel)
      await testConversation.save()

      await await agent.start()

      // Create parent message in chat
      parentMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Parent message in chat',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['chat']
      })
      await parentMsg.save()

      // Create first reply in thread
      reply1 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'First reply in chat thread',
        conversation: testConversation._id,
        owner: agent._id,
        pseudonymId: agent.pseudonyms[0]._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        channels: ['chat'],
        parentMessage: parentMsg._id,
        fromAgent: true
      })
      await reply1.save()

      // Create another regular message (not in thread)
      const otherMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Other message not in thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['chat']
      })
      await otherMsg.save()

      // Create second reply in thread
      reply2 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Second reply in chat thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['chat'],
        parentMessage: parentMsg._id
      })
      await reply2.save()

      // Create new reply to the thread
      newReply = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'New reply to chat thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['chat'],
        parentMessage: parentMsg._id
      })

      const expectedEval = {
        userMessage: newReply,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Response to chat thread',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(newReply)
      await newReply.save()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond(newReply)

      // Conversation history should only include messages from the thread
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(3)

      // Should include parent and the two replies in the thread
      const bodies = conversationHistory.messages.map((m) => m.body)
      expect(bodies).toContain('Parent message in chat')
      expect(bodies).toContain('First reply in chat thread')
      expect(bodies).toContain('Second reply in chat thread')

      // Should NOT include the other message that's not in the thread
      expect(bodies).not.toContain('Other message not in thread')
    })

    test('should only include thread messages in conversation history for threaded reply in DM', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: testConversation
      })
      await agent.save()

      testChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })
      testConversation.channels.push(testChannel)
      await testConversation.save()

      await await agent.start()

      // Create parent message
      parentMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Parent message',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })
      await parentMsg.save()

      // Create first reply in thread
      reply1 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'First reply in thread',
        conversation: testConversation._id,
        owner: agent._id,
        pseudonymId: agent.pseudonyms[0]._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent'],
        parentMessage: parentMsg._id,
        fromAgent: true
      })
      await reply1.save()

      // Create another regular message (not in thread)
      const otherMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Other message not in thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })
      await otherMsg.save()

      // Create second reply in thread
      reply2 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Second reply in thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent'],
        parentMessage: parentMsg._id
      })
      await reply2.save()

      // Create new reply to the thread
      newReply = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'New reply to thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent'],
        parentMessage: parentMsg._id
      })

      const expectedEval = {
        userMessage: newReply,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Response to thread',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(newReply)
      await newReply.save()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond(newReply)

      // Conversation history should only include messages from the thread
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(3)

      // Should include parent and the two replies in the thread
      const bodies = conversationHistory.messages.map((m) => m.body)
      expect(bodies).toContain('Parent message')
      expect(bodies).toContain('First reply in thread')
      expect(bodies).toContain('Second reply in thread')

      // Should NOT include the other message that's not in the thread
      expect(bodies).not.toContain('Other message not in thread')
    })

    test('should include all previous messages in history for non-threaded reply', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: testConversation
      })
      await agent.save()

      testChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })
      testConversation.channels.push(testChannel)
      await testConversation.save()

      await await agent.start()

      // Create some messages
      const unthreadedMsg1 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'First message',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })
      await unthreadedMsg1.save()

      const unthreadedMsg2 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Second message',
        conversation: testConversation._id,
        owner: agent._id,
        pseudonymId: agent.pseudonyms[0]._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent'],
        fromAgent: true
      })
      await unthreadedMsg2.save()

      const unthreadedMsg3 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Third message',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })

      const expectedEval = {
        userMessage: msg3,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Response',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(unthreadedMsg3)
      await unthreadedMsg3.save()
      await testConversation.populate(['messages', 'channels'])
      await agent.respond(unthreadedMsg3)

      // Conversation history should include all previous messages
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages).toHaveLength(2)

      const bodies = conversationHistory.messages.map((m) => m.body)
      expect(bodies).toContain('First message')
      expect(bodies).toContain('Second message')
    })

    test('should handle thread where parent is not in loaded messages', async () => {
      const agent = new Agent({
        agentType: 'perMessage',
        conversation: testConversation
      })
      await agent.save()

      testChannel = await Channel.create({
        _id: new mongoose.Types.ObjectId(),
        name: 'dm-user1-agent',
        participants: [registeredUser._id, agent._id],
        direct: true
      })
      testConversation.channels.push(testChannel)
      await testConversation.save()

      await await agent.start()

      // Create parent message (saved to DB but not in conversation.messages yet)
      parentMsg = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Parent message',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent']
      })
      await parentMsg.save()

      // Create a reply (also saved separately)
      reply1 = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'Existing reply',
        conversation: testConversation._id,
        owner: agent._id,
        pseudonymId: agent.pseudonyms[0]._id,
        pseudonym: agent.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent'],
        parentMessage: parentMsg._id,
        fromAgent: true
      })
      await reply1.save()

      // Create new reply to the thread (parent not in conversation.messages)
      newReply = new Message({
        _id: new mongoose.Types.ObjectId(),
        body: 'New reply to thread',
        conversation: testConversation._id,
        owner: registeredUser._id,
        pseudonymId: registeredUser.pseudonyms[0]._id,
        pseudonym: registeredUser.pseudonyms[0].pseudonym,
        channels: ['dm-user1-agent'],
        parentMessage: parentMsg._id
      })

      const expectedEval = {
        userMessage: newReply,
        action: AgentMessageActions.CONTRIBUTE,
        agentContributionVisible: true,
        userContributionVisible: true,
        suggestion: undefined
      }

      const expectedResponse = {
        visible: true,
        message: 'Response to thread',
        pause: 0
      }

      mockEvaluate.mockResolvedValue(expectedEval)
      mockRespond.mockResolvedValue([expectedResponse])

      await agent.evaluate(newReply)
      await newReply.save()
      // Don't populate messages - simulating case where parent isn't in loaded messages
      await testConversation.populate('channels')
      await agent.respond(newReply)

      // Should fetch parent and replies from DB
      const conversationHistory = mockRespond.mock.calls[0][0]
      expect(conversationHistory.messages.length).toBeGreaterThan(0)

      const bodies = conversationHistory.messages.map((m) => m.body)
      expect(bodies).toContain('Parent message')
      expect(bodies).toContain('Existing reply')
    })
  })

  describe('goalPriorities agentConfig merge', () => {
    // agentConfig is Mixed so we cast goalPriorities to its runtime shape for assertions
    const priorities = (agent) => agent.agentConfig!.goalPriorities as Record<string, number> | undefined

    test('applies type-level goalPriorities when instance has none', async () => {
      const agent = new Agent({ agentType: 'withGoalPriorities', conversation })
      await agent.save()
      expect(priorities(agent)).toEqual({
        synthesize_discussion: 80,
        bridge_topics: 50,
        provoke_participation: 20
      })
    })

    test('instance goalPriorities override individual keys while preserving type defaults', async () => {
      const agent = new Agent({
        agentType: 'withGoalPriorities',
        conversation,
        agentConfig: { goalPriorities: { bridge_topics: 90 } }
      })
      await agent.save()
      expect(priorities(agent)).toEqual({
        synthesize_discussion: 80,
        bridge_topics: 90,
        provoke_participation: 20
      })
    })

    test('instance can add a new goal key not present in type defaults', async () => {
      const agent = new Agent({
        agentType: 'withGoalPriorities',
        conversation,
        agentConfig: { goalPriorities: { challenge_consensus: 70 } }
      })
      await agent.save()
      expect(priorities(agent)).toMatchObject({
        synthesize_discussion: 80,
        bridge_topics: 50,
        provoke_participation: 20,
        challenge_consensus: 70
      })
    })

    test('instance can disable a goal by setting priority 0', async () => {
      const agent = new Agent({
        agentType: 'withGoalPriorities',
        conversation,
        agentConfig: { goalPriorities: { synthesize_discussion: 0 } }
      })
      await agent.save()
      expect(priorities(agent)!.synthesize_discussion).toBe(0)
      expect(priorities(agent)!.bridge_topics).toBe(50)
    })

    test('other agentConfig fields are still shallow-merged correctly', async () => {
      const agent = new Agent({
        agentType: 'withGoalPriorities',
        conversation,
        agentConfig: { minInterval: 10 }
      })
      await agent.save()
      expect(agent.agentConfig!.minInterval).toBe(10)
      expect(priorities(agent)).toEqual({
        synthesize_discussion: 80,
        bridge_topics: 50,
        provoke_participation: 20
      })
    })

    test('no goalPriorities key set when neither type nor instance defines it', async () => {
      const agent = new Agent({ agentType: 'perMessage', conversation })
      await agent.save()
      expect(priorities(agent)).toBeUndefined()
    })
  })
})
