import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import logger from '../../../src/config/logger.js'
import registerConversationHandlers, { collectChannelIntros } from '../../../src/websockets/handlers/conversationHandlers.js'
import { getRoomId } from '../../../src/websockets/utils.js'
import { Agent, AgentIntroduction, Channel, Conversation } from '../../../src/models/index.js'
import { setAgentTypes } from '../../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../../src/agents/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../../src/agents/helpers/getModelChat.js'
import { insertUsers, userOne, userTwo } from '../../fixtures/user.fixture.js'
import { newPublicTopic, insertTopics } from '../../fixtures/topic.fixture.js'
import { conversationOne, publicTopic, insertConversations } from '../../fixtures/conversation.fixture.js'

setupIntTest()

const registerWithFakeSocket = () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const socket = {
    join: jest.fn(),
    leave: jest.fn(),
    use: jest.fn(),
    disconnect: jest.fn(),
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler
    }
  }
  registerConversationHandlers({}, socket)
  return { handlers, socket }
}

// catchAsync swallows a failed join into logger.error and never calls back, so surface it instead of timing out
const joinAndWaitForCallback = (handler, data) =>
  new Promise((resolve, reject) => {
    jest.spyOn(logger, 'error').mockImplementation((err) => {
      reject(err instanceof Error ? err : new Error(String(err)))
      return logger
    })
    handler(data, resolve)
  })

describe('conversation:join logging', () => {
  let infoSpy
  let conversation
  let channel
  let user

  beforeEach(async () => {
    await insertUsers([userOne])
    const topic = newPublicTopic()
    await insertTopics([topic])
    user = { _id: userOne._id, email: userOne.email }
    conversation = await Conversation.create({
      name: 'Join timing room',
      owner: userOne._id,
      topic: topic._id,
      enableDMs: [],
      enableAgents: false
    })
    channel = await Channel.create({ name: 'general', conversation: conversation._id })
    conversation.channels = [channel._id]
    await conversation.save()
    infoSpy = jest.spyOn(logger, 'info').mockReturnValue(logger)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const joinLines = () => infoSpy.mock.calls.map((call) => String(call[0])).filter((m) => m.startsWith('Socket join:'))

  it('logs one info line naming the user, the room, and the elapsed time', async () => {
    const { handlers } = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['conversation:join'], { conversationId: conversation._id, user })

    const lines = joinLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`user ${userOne._id}`)
    expect(lines[0]).toContain(`room ${conversation._id}`)
    expect(lines[0]).toMatch(/ in \d+ms$/)
  })

  it('logs one info line for a channel join', async () => {
    const { handlers } = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['channel:join'], {
      conversationId: conversation._id,
      user,
      channel: { name: channel.name, passcode: channel.passcode }
    })

    const lines = joinLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`room ${conversation._id}_general`)
    expect(lines[0]).toMatch(/ in \d+ms$/)
  })
})

/* Socket.io gives a client no room attribution on a received event, so a client moving
   between conversations leaves the old bare room to stop hearing its events. */
describe('conversation:leave', () => {
  it('leaves the bare conversation room and nothing else', async () => {
    const { handlers, socket } = registerWithFakeSocket()
    const conversationId = new mongoose.Types.ObjectId()

    await handlers['conversation:leave']({ conversationId })

    expect(socket.leave).toHaveBeenCalledTimes(1)
    expect(socket.leave).toHaveBeenCalledWith(getRoomId(conversationId.toString()))
    expect(socket.disconnect).not.toHaveBeenCalled()
  })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIntroduce = jest.fn<(...args: any[]) => Promise<any>>()

const testAgentTypes = {
  introducingAgent: {
    respond: jest.fn(),
    evaluate: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    introduce: mockIntroduce,
    name: 'Introducing Agent',
    description: 'An agent that greets every channel it is asked to',
    maxTokens: 2000,
    defaultTriggers: { perMessage: {} },
    priority: 10,
    llmTemplateVars: {},
    llmTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel
  }
}

/* The join handler's ack is what unblocks the client's history fetch, and a DM intro is a live
   LLM call, so a reconnecting participant must not trigger introduce() again. */
describe('collectChannelIntros', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conversation: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let agents: any[]
  let dmChannelName: string

  beforeAll(async () => {
    setAgentTypes(testAgentTypes)
    await AgentIntroduction.syncIndexes()
  })

  afterAll(() => {
    setAgentTypes(defaultAgentTypes)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  beforeEach(async () => {
    mockIntroduce.mockReset()
    mockIntroduce.mockImplementation(async (channel) => [
      { message: 'Hello from an agent', channels: [channel], visible: true }
    ])
    await insertUsers([userOne, userTwo])
    await insertTopics([publicTopic])
    await insertConversations([conversationOne])

    agents = []
    for (let i = 0; i < 2; i++) {
      const agent = new Agent({ agentType: 'introducingAgent', conversation: conversationOne._id, active: true })
      await agent.save()
      agents.push(agent)
    }
    dmChannelName = `direct-${userOne._id}-${agents[0]._id}`
    const chatChannel = await Channel.create({ name: 'chat', passcode: null })
    const dmChannel = await Channel.create({
      name: dmChannelName,
      passcode: null,
      direct: true,
      participants: [userOne._id, agents[0]._id]
    })
    await Conversation.updateOne(
      { _id: conversationOne._id },
      { $set: { agents: agents.map((a) => a._id), channels: [chatChannel._id, dmChannel._id] } }
    )
    conversation = await Conversation.findById(conversationOne._id).populate(['agents', 'channels'])
  })

  const joinAs = (user) => collectChannelIntros(conversation, ['chat', dmChannelName], user)

  test('asks every agent to introduce itself on a participant’s first join', async () => {
    const intros = await joinAs(userOne)

    // Both agents greet 'chat'; only agents[0] is a participant of the DM channel.
    expect(mockIntroduce).toHaveBeenCalledTimes(3)
    expect(intros).toHaveLength(3)
    expect(intros.map((intro) => intro.channels)).toEqual([['chat'], ['chat'], [dmChannelName]])
  })

  test('replays the saved greetings without any introduce() calls when the same participant joins again', async () => {
    const firstJoinIntros = await joinAs(userOne)
    mockIntroduce.mockClear()

    const intros = await joinAs(userOne)

    expect(mockIntroduce).not.toHaveBeenCalled()
    expect(intros).toHaveLength(3)
    expect(intros.map((intro) => intro.body)).toEqual(firstJoinIntros.map((intro) => intro.body))
    expect(intros.map((intro) => intro.channels)).toEqual(firstJoinIntros.map((intro) => intro.channels))
    expect(intros.map((intro) => intro.pseudonymId)).toEqual(firstJoinIntros.map((intro) => intro.pseudonymId))
  })

  test('still introduces every agent to a different participant on their first join', async () => {
    await joinAs(userOne)
    mockIntroduce.mockClear()

    const intros = await collectChannelIntros(conversation, ['chat'], userTwo)

    expect(mockIntroduce).toHaveBeenCalledTimes(2)
    expect(intros.map((intro) => intro.channels)).toEqual([['chat'], ['chat']])
  })

  test('asks again next join when an agent produced no intro the first time', async () => {
    mockIntroduce.mockResolvedValueOnce([])
    await joinAs(userOne)
    mockIntroduce.mockClear()

    await joinAs(userOne)

    expect(mockIntroduce).toHaveBeenCalledTimes(1)
    expect(mockIntroduce.mock.calls[0][0].name).toEqual('chat')
  })

  test('skips only the channels a participant has already been introduced on', async () => {
    await collectChannelIntros(conversation, ['chat'], userOne)
    mockIntroduce.mockClear()

    const intros = await joinAs(userOne)

    expect(mockIntroduce).toHaveBeenCalledTimes(1)
    expect(intros.map((intro) => intro.channels)).toEqual([['chat'], ['chat'], [dmChannelName]])
  })

  test('gives two joins racing from the same participant identical greetings', async () => {
    let greetingsGenerated = 0
    mockIntroduce.mockImplementation(async () => {
      greetingsGenerated += 1
      return [{ message: `Hello number ${greetingsGenerated}`, visible: true }]
    })

    const [first, second] = await Promise.all([joinAs(userOne), joinAs(userOne)])

    expect(first).toHaveLength(3)
    expect(second.map((intro) => intro.body)).toEqual(first.map((intro) => intro.body))
    expect(await AgentIntroduction.countDocuments({ user: userOne._id })).toBe(3)
  })

  test('returns nothing for an inactive conversation without recording anything', async () => {
    conversation.active = false

    const intros = await joinAs(userOne)
    conversation.active = true
    const introsAfterReactivation = await joinAs(userOne)

    expect(intros).toEqual([])
    expect(introsAfterReactivation).toHaveLength(3)
  })
})
