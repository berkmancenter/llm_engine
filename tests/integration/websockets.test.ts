import io from 'socket.io-client'
import { createServer } from 'http'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { userOneAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { conversationOne, conversationTwo, insertConversations, publicTopic } from '../fixtures/conversation.fixture.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'

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
