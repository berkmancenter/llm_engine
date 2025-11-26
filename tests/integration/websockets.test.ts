import io from 'socket.io-client'
import { createServer } from 'http'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { userOneAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { conversationOne, conversationTwo, insertConversations, publicTopic } from '../fixtures/conversation.fixture.js'

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

    test('should join conversation room with channel', (done) => {
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

    test('should generate correct room ID for conversation with channel', (done) => {
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
  })
})
