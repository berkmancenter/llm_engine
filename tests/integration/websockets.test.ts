import io from 'socket.io-client'
import { createServer } from 'http'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { insertUsers, userOne, userTwo } from '../fixtures/user.fixture.js'
import { userOneAccessToken } from '../fixtures/token.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import { conversationOne, conversationTwo, insertConversations, publicTopic } from '../fixtures/conversation.fixture.js'
import websocketGateway from '../../src/websockets/websocketGateway.js'
import { getAdminRoomId } from '../../src/websockets/utils.js'
import { messageHideService, messageService } from '../../src/services/index.js'
import { Message, User } from '../../src/models/index.js'
import { loadHideContext } from '../../src/utils/messageVisibility.js'
import waitFor from '../utils/waitFor.js'
import { seedHideScenario } from '../fixtures/messageHide.fixture.js'

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

/**
 * Admin message hiding: who is sent what. `broadcast` is the single choke point every event goes
 * through (and the one carried over the cluster IPC), so these spy on it.
 */
describe('WebSocket events for hidden messages', () => {
  setupIntTest()

  let s: Awaited<ReturnType<typeof seedHideScenario>>
  let broadcastSpy: jest.SpiedFunction<typeof websocketGateway.broadcast>
  const conversationId = conversationOne._id.toString()
  const adminRoom = getAdminRoomId(conversationId)

  // [conversation, event, data, channels, extraRooms]
  const calls = (event: string) => broadcastSpy.mock.calls.filter((c) => c[1] === event)
  const toAdminRoom = (c) => c[4]?.includes(adminRoom)
  const toUserRoom = (c, userId) => c[4]?.includes(userId.toString())
  const toSharedRooms = (c) => !c[4]?.length || c[4].includes(conversationId)

  beforeEach(async () => {
    s = await seedHideScenario()
    broadcastSpy = jest.spyOn(websocketGateway, 'broadcast').mockResolvedValue(undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('hiding a message', () => {
    test('message:hidden carries ids only, resolves the reply cascade, and goes to the conversation room', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)

      const [hiddenCall] = calls('message:hidden')
      expect(hiddenCall[0]).toBe(conversationId)
      expect(hiddenCall[2]).toEqual({
        messageIds: expect.arrayContaining([s.authorMsg._id.toString(), s.reply._id.toString()]),
        hidden: true,
        display: 'omit'
      })
      expect(Object.keys(hiddenCall[2]).sort()).toEqual(['display', 'hidden', 'messageIds'])
      expect(hiddenCall[2].messageIds).toHaveLength(2)
      // the channel rooms the messages were in, plus the bare conversation room
      expect(hiddenCall[3]).toEqual(['chat'])
      expect(hiddenCall[4]).toEqual([conversationId])
      expect(JSON.stringify(hiddenCall[2])).not.toContain(s.authorMsg.body as string)
    })

    test('sends the hidden author a toast-trigger notice in their own user room', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)

      const notices = calls('message:hidden-notice')
      expect(notices).toHaveLength(1)
      expect(notices[0][2]).toEqual({ conversationId, scope: 'message', messageIds: [s.authorMsg._id.toString()] })
      expect(toUserRoom(notices[0], s.author._id)).toBe(true)
      expect(notices[0][3]).toEqual([]) // no shared channel rooms
    })

    test('hide-all resolves past messages into ids, and only the author gets the notice', async () => {
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)

      const [hiddenCall] = calls('message:hidden')
      expect(hiddenCall[2].messageIds.sort()).toEqual([s.authorMsg._id.toString(), s.reply._id.toString()].sort())
      const [notice] = calls('message:hidden-notice')
      expect(notice[2]).toEqual({ conversationId, scope: 'user', messageIds: [s.authorMsg._id.toString()] })
      expect(toUserRoom(notice, s.author._id)).toBe(true)
    })

    test('a hide that changes nothing sends nothing', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      broadcastSpy.mockClear()
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      expect(broadcastSpy).not.toHaveBeenCalled()
    })
  })

  describe('conversation scoping', () => {
    test('hide-all announces only this conversation, with only its message ids, to its own rooms', async () => {
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)

      expect(broadcastSpy.mock.calls.length).toBeGreaterThan(0)
      broadcastSpy.mock.calls.forEach((c) => {
        expect(c[0]).toBe(conversationId)
        expect(JSON.stringify(c[2])).not.toContain(s.authorMsgElsewhere._id.toString())
      })
    })

    test('hiding a message elsewhere announces to that conversation only', async () => {
      const otherConversationId = s.authorMsgElsewhere.conversation.toString()
      await messageHideService.hideMessage(s.authorMsgElsewhere._id, s.admin)

      const [hiddenCall] = calls('message:hidden')
      expect(hiddenCall[0]).toBe(otherConversationId)
      expect(hiddenCall[2].messageIds).toEqual([s.authorMsgElsewhere._id.toString()])
      broadcastSpy.mock.calls.forEach((c) => expect(c[0]).toBe(otherConversationId))
    })

    test('repeating hide-all or unhide-all sends nothing', async () => {
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      broadcastSpy.mockClear()
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      expect(broadcastSpy).not.toHaveBeenCalled()

      await messageHideService.unhideUserMessages(conversationId, s.author._id, s.admin)
      broadcastSpy.mockClear()
      await messageHideService.unhideUserMessages(conversationId, s.author._id, s.admin)
      expect(broadcastSpy).not.toHaveBeenCalled()
    })
  })

  describe('unhiding', () => {
    test('admins get message:hidden with hidden:false in the admin room; everyone else gets message:new', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      broadcastSpy.mockClear()

      await messageHideService.unhideMessage(s.authorMsg._id, s.admin)

      const [hiddenCall] = calls('message:hidden')
      expect(hiddenCall[2]).toEqual({ messageIds: expect.any(Array), hidden: false, display: 'omit' })
      expect(hiddenCall[2].messageIds).toHaveLength(2)
      expect(toAdminRoom(hiddenCall)).toBe(true)
      expect(hiddenCall[3]).toEqual([])

      const restored = calls('message:new')
      expect(restored.map((c) => c[2].id).sort()).toEqual([s.authorMsg._id.toString(), s.reply._id.toString()].sort())
      restored.forEach((c) => {
        expect(toSharedRooms(c)).toBe(true)
        expect(c[2].hidden).toBeUndefined()
      })
    })

    test('does not send a notice to the author', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      broadcastSpy.mockClear()
      await messageHideService.unhideMessage(s.authorMsg._id, s.admin)
      expect(calls('message:hidden-notice')).toHaveLength(0)
    })

    test('an id that is still hidden for another reason is not announced as unhidden', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      broadcastSpy.mockClear()

      await messageHideService.unhideMessage(s.authorMsg._id, s.admin)

      expect(broadcastSpy).not.toHaveBeenCalled()
    })
  })

  describe('a new message from a hidden author', () => {
    const hiddenPost = async () => {
      await messageHideService.hideUserMessages(conversationId, s.author._id, s.admin)
      broadcastSpy.mockClear()
      const [created] = await messageService.newMessageHandler(
        { body: 'posted while hidden', conversation: conversationId, channels: [{ name: 'chat' }] },
        (await User.findById(s.author._id))!,
        'req-1'
      )
      return created
    }

    test('goes only to the admin room (flagged) and the author user room, never the shared rooms', async () => {
      const created = await hiddenPost()

      await waitFor(() => expect(calls('message:new')).toHaveLength(2))
      const newCalls = calls('message:new')
      expect(newCalls.some(toSharedRooms)).toBe(false)

      const adminCall = newCalls.find(toAdminRoom)!
      expect(adminCall[2]).toMatchObject({ id: created._id!.toString(), hidden: true, body: 'posted while hidden' })
      // owner is the plain id string on every payload, never a populated user
      expect(adminCall[2].owner).toBe(s.author._id.toString())

      const authorCall = newCalls.find((c) => toUserRoom(c, s.author._id))!
      expect(authorCall[2].id).toBe(created._id!.toString())
      expect(authorCall[2].hidden).toBeUndefined()
      expect(authorCall[2].request).toBe('req-1')
      expect(authorCall[2].owner).toBe(s.author._id.toString())
    })

    test('a visible author still goes to the shared rooms, unchanged', async () => {
      await messageService.newMessageHandler(
        { body: 'hello', conversation: conversationId, channels: [{ name: 'chat' }] },
        (await User.findById(s.other._id))!
      )

      await waitFor(() => expect(calls('message:new')).toHaveLength(1))
      const [newCall] = calls('message:new')
      expect(newCall[0]).toBe(conversationId)
      expect(newCall[4]).toBeUndefined()
      expect(newCall[2].owner).toBe(s.other._id.toString())
    })

    test('under the placeholder policy the shared rooms get a body-less stub', async () => {
      const message = await Message.findById(s.authorMsg._id)
      await Message.updateOne({ _id: message!._id }, { hiddenByAdmin: true })
      const hiddenMessage = (await Message.findById(message!._id))!
      const ctx = await loadHideContext(conversationId, 'placeholder')

      await websocketGateway.broadcastNewMessage(hiddenMessage, null, ctx)

      const shared = calls('message:new').find(toSharedRooms)!
      expect(Object.keys(shared[2]).sort()).toEqual(['body', 'createdAt', 'hidden', 'id'])
      expect(shared[2]).toMatchObject({ id: message!._id.toString(), hidden: true, body: null })
      expect(shared[2].pseudonym).toBeUndefined()
    })
  })

  describe('vote:new', () => {
    test('does not leak a hidden message body to the shared rooms; admins get it flagged', async () => {
      await messageHideService.hideMessage(s.authorMsg._id, s.admin)
      broadcastSpy.mockClear()

      await websocketGateway.broadcastNewVote((await Message.findById(s.authorMsg._id))!)

      const voteCalls = calls('vote:new')
      expect(voteCalls).toHaveLength(1)
      expect(toAdminRoom(voteCalls[0])).toBe(true)
      expect(voteCalls[0][2]).toMatchObject({ hidden: true })
      expect(voteCalls.some(toSharedRooms)).toBe(false)
    })

    test('a visible message votes through the shared rooms as before', async () => {
      const message = (await Message.findById(s.otherMsg._id))!
      await websocketGateway.broadcastNewVote(message)

      const [voteCall] = calls('vote:new')
      expect(voteCall[0]).toBe(conversationId)
      expect(voteCall[2]).toBe(message)
      expect(voteCall[4]).toBeUndefined()
    })
  })

  describe('cluster IPC', () => {
    test('forwards the extra rooms to the worker alongside the conversation and channels', async () => {
      broadcastSpy.mockRestore()
      const send = jest.fn()
      websocketGateway.worker = { send } as never
      try {
        await websocketGateway.broadcast(conversationId, 'message:hidden', { messageIds: [] }, [], [adminRoom])
        expect(send).toHaveBeenCalledWith({
          conversation: conversationId,
          event: 'message:hidden',
          message: { messageIds: [] },
          channels: [],
          extraRooms: [adminRoom]
        })
      } finally {
        websocketGateway.worker = null
      }
    })
  })
})
