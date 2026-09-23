import request from 'supertest'
import httpStatus from 'http-status'
import io from 'socket.io-client'
import { Server as SocketIOServer } from 'socket.io'
import { createServer } from 'http'
import moment from 'moment'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne } from '../fixtures/user.fixture.js'
import { userOneAccessToken } from '../fixtures/token.fixture.js'
import { newPublicTopic, insertTopics } from '../fixtures/topic.fixture.js'
import { Conversation, ConversationMembership, Message, User, Agent } from '../../src/models/index.js'
import userService from '../../src/services/user.service.js'
import { setAgentTypes } from '../../src/models/user.model/agent.model/index.js'
import defaultAgentTypes from '../../src/agents/index.js'
import { defaultLLMPlatform, defaultLLMModel } from '../../src/agents/helpers/getModelChat.js'
import registerConversationHandlers from '../../src/websockets/handlers/conversationHandlers.js'
import tokenService from '../../src/services/token.service.js'
import tokenTypes from '../../src/config/tokens.js'
import config from '../../src/config/config.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import faker from 'faker' // eslint-disable-line import/order

const testAgentTypeSpec = {
  test: {
    respond: jest.fn(),
    evaluate: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    name: 'Test Agent',
    description: 'A test agent',
    maxTokens: 2000,
    defaultTriggers: undefined,
    priority: 100,
    llmTemplateVars: {},
    defaultLLMTemplates: {},
    defaultLLMPlatform,
    defaultLLMModel
  }
}

setupIntTest()

const generateToken = (userId) =>
  tokenService.generateToken(userId, moment().add(config.jwt.accessExpirationMinutes, 'minutes'), tokenTypes.ACCESS)

const createParticipant = async () => {
  const user = await User.create({
    username: faker.internet.userName(),
    email: faker.internet.email().toLowerCase(),
    password: 'password123',
    role: 'participant',
    isEmailVerified: false,
    pseudonyms: [{ pseudonym: faker.name.findName(), token: faker.datatype.uuid(), active: true }]
  })
  return { user, token: generateToken(user._id) }
}

describe('membership enforcement — HTTP and socket entry points', () => {
  let topic
  let enforcedConv
  let member
  let nonMember

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(websocketGateway, 'broadcastNewMessage').mockResolvedValue(undefined as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(websocketGateway, 'broadcastNewVote').mockResolvedValue(undefined as any)

    await insertUsers([userOne])

    topic = newPublicTopic()
    topic.owner = userOne._id
    await insertTopics([topic])

    member = await createParticipant()
    nonMember = await createParticipant()

    enforcedConv = await Conversation.create({
      name: 'Members Only',
      owner: userOne._id,
      topic: topic._id,
      enforceMembership: true,
      useRealNames: false,
      enableDMs: [],
      enableAgents: false
    })

    await ConversationMembership.create({
      conversation: enforcedConv._id,
      email: member.user.email,
      name: 'Test Member',
      userAccount: member.user._id
    })

    await Message.create({
      body: 'A message in the room',
      bodyType: 'text',
      conversation: enforcedConv._id,
      owner: member.user._id,
      pseudonym: member.user.pseudonyms[0].pseudonym,
      pseudonymId: member.user.pseudonyms[0]._id,
      visible: true
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('GET /v1/messages/:conversationId', () => {
    test('non-member gets 403', async () => {
      await request(app)
        .get(`/v1/messages/${enforcedConv._id}`)
        .set('Authorization', `Bearer ${nonMember.token}`)
        .expect(httpStatus.FORBIDDEN)
    })

    test('member gets 200', async () => {
      await request(app)
        .get(`/v1/messages/${enforcedConv._id}`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(httpStatus.OK)
    })

    test('admin gets 200', async () => {
      await request(app)
        .get(`/v1/messages/${enforcedConv._id}`)
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .expect(httpStatus.OK)
    })
  })

  describe('POST /v1/messages', () => {
    test('non-member gets 403', async () => {
      await request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${nonMember.token}`)
        .send({ conversation: enforcedConv._id, body: 'hello' })
        .expect(httpStatus.FORBIDDEN)
    })

    test('member gets 201', async () => {
      await request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${member.token}`)
        .send({ conversation: enforcedConv._id, body: 'hello from member' })
        .expect(httpStatus.CREATED)
    })

    test('admin gets 201', async () => {
      await request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ conversation: enforcedConv._id, body: 'hello from admin' })
        .expect(httpStatus.CREATED)
    })
  })

  describe('real-name room: admin posting and the author admin flag', () => {
    let room
    let memberMessage
    let broadcastSpy

    const historyFor = async (conversationId, token = userOneAccessToken) => {
      const res = await request(app)
        .get(`/v1/messages/${conversationId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(httpStatus.OK)
      return res.body
    }

    const postAsAdmin = (body, extra = {}) =>
      request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ conversation: room._id, body, ...extra })

    beforeEach(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(websocketGateway.broadcastNewMessage as any).mockRestore()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      broadcastSpy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined as any)

      room = await Conversation.create({
        name: 'Community Room',
        owner: userOne._id,
        topic: topic._id,
        enforceMembership: true,
        useRealNames: true,
        enableDMs: [],
        enableAgents: false
      })
      await ConversationMembership.create({
        conversation: room._id,
        email: member.user.email,
        name: 'Jane Doe',
        userAccount: member.user._id
      })
      member.user.pseudonyms.push({
        token: faker.datatype.uuid(),
        pseudonym: 'Jane Doe',
        active: false,
        isRealName: true,
        conversations: [room._id.toString()]
      })
      await member.user.save()

      // The admin claims a name for this room, which is what the frontend prompt does.
      await userService.registerRealName(await User.findById(userOne._id), room._id.toString(), 'Alex Admin')

      memberMessage = await Message.create({
        body: 'hi from a member',
        bodyType: 'text',
        conversation: room._id,
        owner: member.user._id,
        pseudonym: 'Jane Doe',
        pseudonymId: member.user.pseudonyms[1]._id,
        visible: true
      })
    })

    test('an admin posts under the name claimed for this room', async () => {
      await postAsAdmin('hello from admin').expect(httpStatus.CREATED)

      const stored = await Message.findOne({ conversation: room._id, owner: userOne._id })
      expect(stored!.pseudonym).toBe('Alex Admin')
    })

    test('an admin with no real name for this room is told to set one', async () => {
      const other = await Conversation.create({
        name: 'Another Community Room',
        owner: userOne._id,
        topic: topic._id,
        enforceMembership: true,
        useRealNames: true,
        enableDMs: [],
        enableAgents: false
      })

      const res = await request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ conversation: other._id, body: 'hello' })
        .expect(httpStatus.BAD_REQUEST)
      expect(res.body.message).toMatch(/set your real name/i)
    })

    describe('POST /v1/users/pseudonyms/real-name', () => {
      const claim = (token, conversationId, realName) =>
        request(app)
          .post('/v1/users/pseudonyms/real-name')
          .set('Authorization', `Bearer ${token}`)
          .send({ conversationId, realName })

      test('an admin claims a name and can then post under it', async () => {
        const other = await Conversation.create({
          name: 'Second Community Room',
          owner: userOne._id,
          topic: topic._id,
          enforceMembership: true,
          useRealNames: true,
          enableDMs: [],
          enableAgents: false
        })

        await claim(userOneAccessToken, other._id, 'Alex Admin').expect(httpStatus.CREATED)

        await request(app)
          .post('/v1/messages')
          .set('Authorization', `Bearer ${userOneAccessToken}`)
          .send({ conversation: other._id, body: 'hello' })
          .expect(httpStatus.CREATED)

        const stored = await Message.findOne({ conversation: other._id, owner: userOne._id })
        expect(stored!.pseudonym).toBe('Alex Admin')
      })

      test('refuses a name another person already holds in that room', async () => {
        const other = await Conversation.create({
          name: 'Third Community Room',
          owner: userOne._id,
          topic: topic._id,
          enforceMembership: true,
          useRealNames: true,
          enableDMs: [],
          enableAgents: false
        })
        await userService.registerRealName(await User.findById(member.user._id), other._id.toString(), 'Alex Admin')

        await claim(userOneAccessToken, other._id, 'alex  admin').expect(httpStatus.CONFLICT)
      })

      // Guests are named by the guest list so nobody can name themselves. Leaving this open to
      // any member would turn a real name into a self-service claim.
      test('refuses a member, since only admins name themselves', async () => {
        await claim(member.token, room._id, 'Someone Else').expect(httpStatus.FORBIDDEN)
      })
    })

    test('history marks which authors are currently admins', async () => {
      await postAsAdmin('hello from admin').expect(httpStatus.CREATED)

      const messages = await historyFor(room._id)
      const adminMessage = messages.find((m) => m.pseudonym === 'Alex Admin')
      const fromMember = messages.find((m) => m.id === memberMessage._id.toString())
      expect(adminMessage.ownerIsAdmin).toBe(true)
      expect(fromMember.ownerIsAdmin).toBe(false)
      expect(adminMessage.owner).toBe(userOne._id.toString())
    })

    test('demoting an admin clears the flag on their earlier messages', async () => {
      await postAsAdmin('hello from admin').expect(httpStatus.CREATED)
      await User.updateOne({ _id: userOne._id }, { $set: { role: 'participant' } })

      const messages = await historyFor(room._id, member.token)
      expect(messages.find((m) => m.pseudonym === 'Alex Admin').ownerIsAdmin).toBe(false)
    })

    test('replies carry the flag too', async () => {
      await postAsAdmin('a reply from admin', { parentMessage: memberMessage._id }).expect(httpStatus.CREATED)

      const res = await request(app)
        .get(`/v1/messages/${memberMessage._id}/replies`)
        .set('Authorization', `Bearer ${member.token}`)
        .expect(httpStatus.OK)
      expect(res.body).toHaveLength(1)
      expect(res.body[0].ownerIsAdmin).toBe(true)
      expect(res.body[0].body).toBe('a reply from admin')
    })

    test('a live message over the socket carries the flag', async () => {
      await postAsAdmin('hello from admin').expect(httpStatus.CREATED)

      const [, event, payload] = broadcastSpy.mock.calls.find(([, name]) => name === 'message:new')
      expect(event).toBe('message:new')
      expect(payload).toMatchObject({ pseudonym: 'Alex Admin', ownerIsAdmin: true })
    })

    // A pseudonymous conversation must not reveal that an anonymous poster is an admin.
    test('a conversation without real names never carries the flag', async () => {
      await request(app)
        .post('/v1/messages')
        .set('Authorization', `Bearer ${userOneAccessToken}`)
        .send({ conversation: enforcedConv._id, body: 'hello from admin' })
        .expect(httpStatus.CREATED)

      const messages = await historyFor(enforcedConv._id)
      messages.forEach((m) => expect(m).not.toHaveProperty('ownerIsAdmin'))
      const [, , payload] = broadcastSpy.mock.calls.find(([, name]) => name === 'message:new')
      expect(payload).not.toHaveProperty('ownerIsAdmin')
    })
  })

  describe('socket conversation:join', () => {
    let server
    let serverPort
    let memberSocket
    let nonMemberSocket
    let dmConv
    let testAgent

    beforeAll(async () => {
      setAgentTypes(testAgentTypeSpec)
      // Socket.io is not initialized in test mode — create a raw server for this suite
      await new Promise<void>((resolve) => {
        server = createServer(app)
        const ioServer = new SocketIOServer(server, { cors: { origin: '*' } })
        ioServer.on('connection', (socket) => {
          registerConversationHandlers(ioServer, socket)
        })
        server.listen(() => {
          serverPort = (server.address() as { port: number }).port
          resolve()
        })
      })
    })

    afterAll(async () => {
      setAgentTypes(defaultAgentTypes)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    beforeEach(async () => {
      // Conversation with DMs so we can observe whether join succeeded via channel creation
      dmConv = await Conversation.create({
        name: 'DM Room',
        owner: userOne._id,
        topic: topic._id,
        enforceMembership: true,
        useRealNames: false,
        enableDMs: ['agents'],
        enableAgents: false
      })

      testAgent = new Agent({
        agentType: 'test',
        conversation: dmConv._id,
        active: false
      })
      await testAgent.save()
      dmConv.agents = [testAgent]
      await dmConv.save()

      await ConversationMembership.create({
        conversation: dmConv._id,
        email: member.user.email,
        name: 'Test Member',
        userAccount: member.user._id
      })

      // Fresh sockets per test (clean join state)
      await new Promise<void>((resolve) => {
        const opts = { forceNew: true }
        memberSocket = io(`http://localhost:${serverPort}`, opts)
        nonMemberSocket = io(`http://localhost:${serverPort}`, opts)
        let connected = 0
        const onConnect = () => {
          if (++connected === 2) resolve()
        }
        memberSocket.on('connect', onConnect)
        nonMemberSocket.on('connect', onConnect)
      })
    })

    afterEach(async () => {
      memberSocket?.close()
      nonMemberSocket?.close()
    })

    test('member join creates DM channel', async () => {
      await new Promise<void>((resolve, reject) => {
        memberSocket.emit('conversation:join', { token: member.token, conversationId: dmConv._id }, (response) => {
          if (response?.intros !== undefined) resolve()
          else reject(new Error('unexpected callback payload'))
        })
        setTimeout(() => reject(new Error('callback not called within timeout')), 2000)
      })

      const updatedConv = await Conversation.findById(dmConv._id).populate('channels')
      const dmChannel = updatedConv!.channels.find((c) => c.name === `direct-${member.user._id}-${testAgent._id}`)
      expect(dmChannel).toBeDefined()
    })

    test('non-member join does not create DM channel', async () => {
      // Callback is never called when membership check fails — use a timeout
      await new Promise<void>((resolve) => {
        let callbackCalled = false
        nonMemberSocket.emit('conversation:join', { token: nonMember.token, conversationId: dmConv._id }, () => {
          callbackCalled = true
        })
        setTimeout(() => {
          expect(callbackCalled).toBe(false)
          resolve()
        }, 500)
      })

      const updatedConv = await Conversation.findById(dmConv._id).populate('channels')
      expect(updatedConv!.channels).toHaveLength(0)
    })
  })
})
