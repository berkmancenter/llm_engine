import io from 'socket.io-client'
import { Server } from 'socket.io'
import { createServer } from 'http'
import request from 'supertest'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, registeredUser, userOne, userTwo } from '../fixtures/user.fixture.js'
import { registeredUserAccessToken, userOneAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { conversationOne, conversationTwo, insertConversations, publicTopic } from '../fixtures/conversation.fixture.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import SocketIO from '../../src/websockets/socketIO.js'
import registerConversationHandlers from '../../src/websockets/handlers/conversationHandlers.js'
import logger from '../../src/config/logger.js'
import waitFor from '../utils/waitFor.js'

describe('WebsocketGateway.broadcastMessageChunk', () => {
  const conversationId = conversationOne._id.toString()

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('broadcasts on the message:chunk event with the supplied channels', async () => {
    const spy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)

    await websocketGateway.broadcastMessageChunk(conversationId, ['transcript'], {
      requestId: 'req-1',
      text: 'Hello.',
      done: false
    })

    expect(spy).toHaveBeenCalledWith(conversationId, 'message:chunk', { requestId: 'req-1', text: 'Hello.', done: false }, [
      'transcript'
    ])
  })

  it('broadcasts the done marker with empty text and done: true', async () => {
    const spy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)

    await websocketGateway.broadcastMessageChunk(conversationId, ['transcript'], {
      requestId: 'req-1',
      text: '',
      done: true
    })

    expect(spy).toHaveBeenCalledWith(conversationId, 'message:chunk', { requestId: 'req-1', text: '', done: true }, [
      'transcript'
    ])
  })

  it('passes chat channel when broadcasting to chat', async () => {
    const spy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)

    await websocketGateway.broadcastMessageChunk(conversationId, ['chat'], {
      requestId: 'req-2',
      text: 'Chat chunk.',
      done: false
    })

    expect(spy).toHaveBeenCalledWith(
      conversationId,
      'message:chunk',
      { requestId: 'req-2', text: 'Chat chunk.', done: false },
      ['chat']
    )
  })
})

describe('WebsocketGateway.broadcastPreferencesUpdated', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("sends preferences:updated only to the room named after the user's id", async () => {
    const spy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)
    const userId = userOne._id.toString()
    const preferences = { jargonClarification: true, visualResponse: false }

    await websocketGateway.broadcastPreferencesUpdated(userId, preferences)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(userId, 'preferences:updated', { userId, preferences })
  })
})

/**
 * Verifies that the websocket handles the renaming from "thread" to "conversation". It does not test edge cases or proper error handling.
 */

describe('WebSocket Integration - Conversation Terminology', () => {
  let server
  let clientSocket1
  let clientSocket2

  setupIntTest()

  beforeAll((done) => {
    server = createServer(app)
    server.listen(() => {
      const { port } = server.address()
      clientSocket1 = io(`http://localhost:${port}`)
      clientSocket2 = io(`http://localhost:${port}`)
      done()
    })
  })

  beforeEach(async () => {
    await insertUsers([userOne, userTwo])
    await insertTopics([publicTopic])
    await insertConversations([conversationOne, conversationTwo])
  })

  afterAll(() => {
    server.close()
    clientSocket1.close()
    clientSocket2.close()
  })

  /* The app only starts Socket.IO in cluster workers, which tests never fork, so this builds its own
     server with the real conversation handlers and points the gateway's emits at it. */
  describe('preferences:updated delivery', () => {
    let socketServer
    let httpServer
    let victim
    let attacker
    let warnSpy

    const connectClient = (port) =>
      new Promise<ReturnType<typeof io>>((resolve) => {
        const client = io(`http://localhost:${port}`, { forceNew: true })
        client.on('connect', () => resolve(client))
      })
    const isInRoom = async (room, client) => (await socketServer.in(room).fetchSockets()).some((s) => s.id === client.id)

    beforeEach(async () => {
      httpServer = createServer()
      socketServer = new Server(httpServer)
      socketServer.on('connection', (socket) => registerConversationHandlers(socketServer, socket))
      await new Promise<void>((resolve) => {
        httpServer.listen(0, resolve)
      })
      jest.spyOn(SocketIO, 'getConnection').mockReturnValue({
        emitMultiple: (rooms, event, data) => socketServer.in(rooms).emit(event, data)
      } as never)
      warnSpy = jest.spyOn(logger, 'warn')
      const { port } = httpServer.address()
      victim = await connectClient(port)
      attacker = await connectClient(port)
    })

    afterEach(async () => {
      victim.close()
      attacker.close()
      jest.restoreAllMocks()
      await socketServer.close()
    })

    test("reaches the user's own socket and not another user's who asked to join their room", async () => {
      await insertUsers([registeredUser])
      const victimId = registeredUser._id.toString()
      const attackerId = userOne._id.toString()
      const attackerEvents: unknown[] = []
      attacker.on('preferences:updated', (payload) => attackerEvents.push(payload))
      const victimReceived = new Promise((resolve) => {
        victim.once('preferences:updated', resolve)
      })

      victim.emit('user:join', { token: registeredUserAccessToken, userId: victimId })
      attacker.emit('user:join', { token: userOneAccessToken, userId: victimId })
      attacker.emit('topic:join', { token: userOneAccessToken, topicId: victimId })
      await waitFor(async () => {
        const attackerInVictimRoom = await isInRoom(victimId, attacker)
        const topicJoinHandled =
          attackerInVictimRoom || warnSpy.mock.calls.some(([msg]) => String(msg).startsWith('topic:join refused'))
        const attackerUserJoinHandled = attackerInVictimRoom || (await isInRoom(attackerId, attacker))
        if (!(await isInRoom(victimId, victim)) || !topicJoinHandled || !attackerUserJoinHandled) {
          throw new Error('joins not processed yet')
        }
      })

      await request(app)
        .put(`/v1/users/user/${victimId}/preferences`)
        .set('Authorization', `Bearer ${registeredUserAccessToken}`)
        .send({ jargonClarification: true })
        .expect(httpStatus.OK)

      expect(await victimReceived).toMatchObject({ userId: victimId, preferences: { jargonClarification: true } })
      // Both sockets would receive the same emit, so a short wait is enough to catch a leak
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(attackerEvents).toEqual([])
    })
  })

  describe('Conversation Room Management', () => {
    test('should join conversation room successfully', (done) => {
      let errorReceived = false

      clientSocket1.emit('conversation:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        request: 'test-request-1'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Failed to join conversation: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should join conversation room with single channel', (done) => {
      let errorReceived = false
      const testChannel = { name: 'general' }

      clientSocket1.emit('conversation:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        channel: testChannel,
        request: 'test-request-2'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Failed to join conversation with channel: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should join conversation room with multiple channels', (done) => {
      let errorReceived = false
      const testChannels = [{ name: 'general' }, { name: 'announcements' }]

      clientSocket1.emit('conversation:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        channels: testChannels,
        request: 'test-request-3'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Failed to join conversation with multiple channels: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should join channel directly', (done) => {
      let errorReceived = false
      const testChannel = { name: 'general' }

      clientSocket1.emit('channel:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        channel: testChannel,
        request: 'test-request-4'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Failed to join channel directly: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should handle conversation disconnect', (done) => {
      let disconnected = false

      clientSocket1.on('disconnect', () => {
        if (!disconnected) {
          disconnected = true
          done()
        }
      })

      clientSocket1.on('connect_error', () => {
        if (!disconnected) {
          disconnected = true
          done()
        }
      })

      clientSocket1.emit('conversation:disconnect')

      setTimeout(() => {
        if (!disconnected) {
          disconnected = true
          done()
        }
      }, 1000)
    })
  })

  describe('Message Creation', () => {
    test('should create message in conversation', (done) => {
      let errorReceived = false

      clientSocket1.emit('message:create', {
        token: userOneAccessToken,
        message: {
          conversation: conversationOne._id,
          body: 'Hello from test!',
          source: 'websocket'
        },
        user: userOne,
        userId: userOne._id,
        request: 'test-message-1'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Failed to create message: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })
  })

  describe('Room ID Generation', () => {
    test('should generate correct room ID for conversation', (done) => {
      let errorReceived = false

      clientSocket1.emit('conversation:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        request: 'test-room-1'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Room ID generation failed: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should generate correct room ID for conversation with single channel', (done) => {
      let errorReceived = false
      const testChannel = { name: 'general' }

      clientSocket1.emit('conversation:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        channel: testChannel,
        request: 'test-room-2'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Room ID generation with channel failed: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should generate correct room IDs for conversation with multiple channels', (done) => {
      let errorReceived = false
      const testChannels = [{ name: 'general' }, { name: 'announcements' }]

      clientSocket1.emit('conversation:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        channels: testChannels,
        request: 'test-room-3'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Room ID generation with multiple channels failed: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })

    test('should generate correct room ID for direct channel join', (done) => {
      let errorReceived = false
      const testChannel = { name: 'general' }

      clientSocket1.emit('channel:join', {
        token: userOneAccessToken,
        conversationId: conversationOne._id,
        channel: testChannel,
        request: 'test-room-4'
      })

      clientSocket1.on('error', (error) => {
        errorReceived = true
        done(new Error(`Room ID generation for direct channel join failed: ${error.message}`))
      })

      setTimeout(() => {
        if (!errorReceived) {
          done()
        }
      }, 500)
    })
  })
})
