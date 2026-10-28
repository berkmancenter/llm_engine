import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import logger from '../../../src/config/logger.js'
import registerConversationHandlers, { collectChannelIntros } from '../../../src/websockets/handlers/conversationHandlers.js'
import { getRoomId, getAdminRoomId } from '../../../src/websockets/utils.js'
import conversationService from '../../../src/services/conversation.service/index.js'
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

  it('passes an observer join through, so the service can leave a shared screen out of the headcount', async () => {
    const joinSpy = jest.spyOn(conversationService, 'joinConversation')
    const { handlers } = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['conversation:join'], {
      conversationId: conversation._id,
      user,
      observer: true
    })

    expect(joinSpy).toHaveBeenCalledWith(conversation._id.toString(), user, { observer: true })
  })

  it('treats a join without the flag as an ordinary participant', async () => {
    const joinSpy = jest.spyOn(conversationService, 'joinConversation')
    const { handlers } = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['conversation:join'], { conversationId: conversation._id, user })

    expect(joinSpy).toHaveBeenCalledWith(conversation._id.toString(), user, { observer: false })
  })

  it('still subscribes an observer to the conversation room and its channel rooms', async () => {
    const { handlers, socket } = registerWithFakeSocket()

    const reply = await joinAndWaitForCallback(handlers['conversation:join'], {
      conversationId: conversation._id,
      user,
      channels: [{ name: channel.name, passcode: channel.passcode }],
      observer: true
    })

    expect(socket.join).toHaveBeenCalledWith(getRoomId(conversation._id.toString()))
    expect(socket.join).toHaveBeenCalledWith(getRoomId(conversation._id.toString(), channel.name))
    expect(reply).toEqual({ intros: expect.any(Array) })
  })
})

/* Socket.io gives a client no room attribution on a received event, so a client moving
   between conversations leaves the old bare room to stop hearing its events. */
describe('conversation:leave', () => {
  it('leaves the bare conversation room and its admin room, and nothing else', async () => {
    const { handlers, socket } = registerWithFakeSocket()
    const conversationId = new mongoose.Types.ObjectId()

    await handlers['conversation:leave']({ conversationId })

    expect(socket.leave).toHaveBeenCalledTimes(2)
    expect(socket.leave).toHaveBeenCalledWith(getRoomId(conversationId.toString()))
    expect(socket.leave).toHaveBeenCalledWith(getAdminRoomId(conversationId.toString()))
    expect(socket.disconnect).not.toHaveBeenCalled()
  })
})

/* The per-user room receives preferences:updated, so a client must not be able to join
   another account's room by sending that account's id. */
describe('user:join', () => {
  it('joins the room for the authenticated user, ignoring the userId the client sent', async () => {
    const { handlers, socket } = registerWithFakeSocket()
    const authenticatedUserId = new mongoose.Types.ObjectId()
    const otherUserId = new mongoose.Types.ObjectId()

    await handlers['user:join']({ user: { _id: authenticatedUserId }, userId: otherUserId })

    expect(socket.join).toHaveBeenCalledTimes(1)
    expect(socket.join).toHaveBeenCalledWith(authenticatedUserId.toString())
  })
})

/* Room names are bare ids, so a topicId that is really someone's user id would land the
   caller in that user's per-user room. */
describe('topic:join', () => {
  it('joins the room for a topic that exists', async () => {
    const { handlers, socket } = registerWithFakeSocket()
    const topic = newPublicTopic()
    await insertTopics([topic])
    const joinedRoom = new Promise((resolve) => {
      socket.join.mockImplementation(resolve)
    })

    handlers['topic:join']({ user: { _id: userOne._id }, topicId: topic._id })

    expect(await joinedRoom).toBe(topic._id.toString())
  })

  it("refuses an id that isn't a topic, such as another user's id", async () => {
    const { handlers, socket } = registerWithFakeSocket()
    const otherUserId = new mongoose.Types.ObjectId()
    let warnSpy
    const refused = new Promise((resolve) => {
      warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {
        resolve(undefined)
        return logger
      })
    })

    handlers['topic:join']({ user: { _id: userOne._id }, topicId: otherUserId })
    await Promise.race([refused, new Promise((resolve) => setTimeout(resolve, 2000))])
    warnSpy.mockRestore()

    expect(socket.join).not.toHaveBeenCalled()
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

  describe('when a shared screen joins as an observer', () => {
    const joinAsObserver = () => {
      const { handlers } = registerWithFakeSocket()
      return joinAndWaitForCallback(handlers['conversation:join'], {
        conversationId: conversationOne._id,
        user: { _id: userOne._id, email: userOne.email },
        channels: [{ name: 'chat', passcode: null }],
        observer: true
      })
    }

    test('greets it with the presentation version and saves nothing', async () => {
      const reply = (await joinAsObserver()) as { intros: unknown[] }

      expect(reply.intros).toHaveLength(2)
      expect(mockIntroduce).toHaveBeenCalledTimes(2)
      expect(mockIntroduce.mock.calls.map((call) => call[1])).toEqual(['presentation', 'presentation'])
      expect(await AgentIntroduction.countDocuments({ user: userOne._id })).toBe(0)
    })

    test('does not replay the greeting saved when the same user joined as a participant', async () => {
      await collectChannelIntros(conversation, ['chat'], userOne)
      mockIntroduce.mockClear()

      await joinAsObserver()

      expect(mockIntroduce.mock.calls.map((call) => call[1])).toEqual(['presentation', 'presentation'])
    })
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

  test('also introduces agents while inactive but inside the preEvent window', async () => {
    conversation.active = false
    conversation.scheduledTime = new Date(Date.now() + 5 * 60 * 1000) // starts in 5 min
    conversation.preEventMinutes = 10 // window opened 5 min ago

    const intros = await joinAs(userOne)

    expect(intros).toHaveLength(3)
  })

  test('still returns nothing for an inactive, already-ended conversation even with preEventMinutes set', async () => {
    conversation.active = false
    conversation.startTime = new Date(Date.now() - 60 * 60 * 1000) // already ran
    conversation.scheduledTime = new Date(Date.now() - 65 * 60 * 1000)
    conversation.preEventMinutes = 10

    const intros = await joinAs(userOne)

    expect(intros).toEqual([])
  })
})

describe('admin room membership', () => {
  let conversation
  let topic

  beforeEach(async () => {
    await insertUsers([userOne])
    topic = newPublicTopic()
    await insertTopics([topic])
    conversation = await Conversation.create({
      name: 'Admin room',
      owner: userOne._id,
      topic: topic._id,
      enableDMs: [],
      enableAgents: false
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  const adminRoom = () => `admin:${conversation._id}`

  it('joins the admin room on conversation:join only when the current role is admin', async () => {
    const asAdmin = registerWithFakeSocket()
    await joinAndWaitForCallback(asAdmin.handlers['conversation:join'], {
      conversationId: conversation._id,
      user: { _id: userOne._id, email: userOne.email, role: 'admin' }
    })
    expect(asAdmin.socket.join).toHaveBeenCalledWith(adminRoom())

    const asParticipant = registerWithFakeSocket()
    await joinAndWaitForCallback(asParticipant.handlers['conversation:join'], {
      conversationId: conversation._id,
      user: { _id: userOne._id, email: userOne.email, role: 'participant' }
    })
    expect(asParticipant.socket.join).not.toHaveBeenCalledWith(adminRoom())
  })

  it('joins the admin room on channel:join for an admin and not for a participant', async () => {
    const channel = await Channel.create({ name: 'general', passcode: null })
    await Conversation.updateOne({ _id: conversation._id }, { channels: [channel._id] })

    const asAdmin = registerWithFakeSocket()
    await joinAndWaitForCallback(asAdmin.handlers['channel:join'], {
      conversationId: conversation._id,
      channel: { name: 'general' },
      user: { _id: userOne._id, role: 'admin' }
    })
    expect(asAdmin.socket.join).toHaveBeenCalledWith(adminRoom())

    const asParticipant = registerWithFakeSocket()
    await joinAndWaitForCallback(asParticipant.handlers['channel:join'], {
      conversationId: conversation._id,
      channel: { name: 'general' },
      user: { _id: userOne._id, role: 'participant' }
    })
    expect(asParticipant.socket.join).not.toHaveBeenCalledWith(adminRoom())
  })

  it('leaves the admin room along with the conversation room on conversation:leave', async () => {
    const { handlers, socket } = registerWithFakeSocket()
    await handlers['conversation:leave']({ conversationId: conversation._id })
    expect(socket.leave).toHaveBeenCalledWith(String(conversation._id))
    expect(socket.leave).toHaveBeenCalledWith(adminRoom())
  })

  it('lets a participant join a channel named admin as an ordinary channel, not the admin room', async () => {
    const adminNamed = await Channel.create({ name: 'admin', passcode: null })
    await Conversation.updateOne({ _id: conversation._id }, { channels: [adminNamed._id] })
    const { handlers, socket } = registerWithFakeSocket()

    await joinAndWaitForCallback(handlers['channel:join'], {
      conversationId: conversation._id,
      channel: { name: 'admin' },
      user: { _id: userOne._id, role: 'participant' }
    })

    expect(socket.join).toHaveBeenCalledWith(`${conversation._id}_admin`)
    expect(socket.join).not.toHaveBeenCalledWith(adminRoom())
  })

  /* The admin room is decided from the user's role at join time. A demotion after that is closed by
     eviction (userService.updateUserRole -> websocketGateway.evictFromAdminRooms, covered in
     adminRoomEviction.test.ts); a re-join under the lower role also leaves the room. A newly promoted
     admin only gets the room on their next join. */
  describe('role changes after joining', () => {
    const adminData = () => ({
      conversationId: conversation._id,
      user: { _id: userOne._id, email: userOne.email, role: 'admin' }
    })
    const participantData = () => ({
      conversationId: conversation._id,
      user: { _id: userOne._id, email: userOne.email, role: 'participant' }
    })

    it('joins a tracker room next to the admin room, so a role change can find the socket', async () => {
      const { handlers, socket } = registerWithFakeSocket()
      await joinAndWaitForCallback(handlers['conversation:join'], adminData())
      expect(socket.join).toHaveBeenCalledWith(`moderator:${userOne._id}`)

      const asParticipant = registerWithFakeSocket()
      await joinAndWaitForCallback(asParticipant.handlers['conversation:join'], participantData())
      expect(asParticipant.socket.join).not.toHaveBeenCalledWith(`moderator:${userOne._id}`)
    })

    it('takes a demoted admin out of the admin room when the same socket joins again', async () => {
      const { handlers, socket } = registerWithFakeSocket()
      await joinAndWaitForCallback(handlers['conversation:join'], adminData())
      expect(socket.join).toHaveBeenCalledWith(adminRoom())

      // the same socket joins again after the user was demoted
      await joinAndWaitForCallback(handlers['conversation:join'], participantData())

      expect(socket.leave).toHaveBeenCalledWith(adminRoom())
    })

    it('puts a promoted user in the admin room only on their next join', async () => {
      const { handlers, socket } = registerWithFakeSocket()
      await joinAndWaitForCallback(handlers['conversation:join'], participantData())
      expect(socket.join).not.toHaveBeenCalledWith(adminRoom())

      await joinAndWaitForCallback(handlers['conversation:join'], adminData())

      expect(socket.join).toHaveBeenCalledWith(adminRoom())
    })
  })
})
