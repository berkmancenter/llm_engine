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
