import { createServer } from 'http'
import { AddressInfo } from 'net'
import { Server } from 'socket.io'
import ioClient from 'socket.io-client'
import setupIntTest from '../../utils/setupIntTest.js'
import SocketIO from '../../../src/websockets/socketIO.js'
import websocketGateway from '../../../src/websockets/websocketGateway.js'
import userService from '../../../src/services/user.service.js'
import { getAdminRoomId, getModeratorTrackerRoomId } from '../../../src/websockets/utils.js'
import { insertUsers, userOne } from '../../fixtures/user.fixture.js'

type ClientSocket = ReturnType<typeof ioClient>

/**
 * Admin-room membership is granted once at join. A role change has to revoke it: real socket.io rooms for the
 * eviction itself, and the role-change path for when it fires.
 */
const conversation = '6ad68fa30914be7fe464298e'
const otherConversation = '6ad68fa30914be7fe464298f'

describe('SocketIO.evictFromAdminRooms', () => {
  let server
  let io: Server
  let socketIO: SocketIO
  const clients: ClientSocket[] = []

  const connect = (port: number, rooms: string[]) =>
    new Promise<ClientSocket>((resolve) => {
      const client = ioClient(`http://localhost:${port}`)
      clients.push(client)
      client.emit('join', rooms, () => resolve(client))
    })

  const nextEvent = (client, event: string) =>
    Promise.race([
      new Promise<boolean>((resolve) => {
        client.once(event, () => resolve(true))
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 300)
      })
    ])

  beforeAll(async () => {
    server = createServer()
    io = new Server(server)
    io.on('connection', (socket) => {
      socket.on('join', (rooms, ack) => {
        socket.join(rooms)
        ack()
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(resolve)
    })
    socketIO = new SocketIO()
    socketIO.io = io
  })

  afterAll(async () => {
    clients.forEach((client) => client.close())
    io.close()
    await new Promise((resolve) => {
      server.close(resolve)
    })
  })

  it('removes the user’s sockets from every admin room, and leaves other users and other rooms alone', async () => {
    const { port } = server.address() as AddressInfo
    const demoted = await connect(port, [
      getAdminRoomId(conversation),
      getAdminRoomId(otherConversation),
      getModeratorTrackerRoomId('user-a'),
      conversation
    ])
    const stillAdmin = await connect(port, [getAdminRoomId(conversation), getModeratorTrackerRoomId('user-b')])

    await socketIO.evictFromAdminRooms('user-a')

    // listeners first: an event emitted before `once` is attached would be missed
    const demotedHidden = nextEvent(demoted, 'hidden')
    const stillAdminHidden = nextEvent(stillAdmin, 'hidden')
    const demotedShared = nextEvent(demoted, 'shared')
    io.in(getAdminRoomId(conversation)).emit('hidden', 'body')
    io.in(getAdminRoomId(otherConversation)).emit('hidden', 'body')
    io.in(conversation).emit('shared', 'ok')

    expect(await demotedHidden).toBe(false)
    expect(await stillAdminHidden).toBe(true)
    // the ordinary conversation room is not an admin room: the demoted user still takes part in the chat
    expect(await demotedShared).toBe(true)
  })

  it('is a no-op for a user with no tracked sockets', async () => {
    await expect(socketIO.evictFromAdminRooms('nobody')).resolves.toBeUndefined()
  })
})

describe('updateUserRole', () => {
  setupIntTest()
  let evictSpy: jest.SpiedFunction<typeof websocketGateway.evictFromAdminRooms>

  beforeEach(async () => {
    await insertUsers([{ ...userOne, role: 'admin' }])
    evictSpy = jest.spyOn(websocketGateway, 'evictFromAdminRooms').mockResolvedValue(undefined)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('evicts the user from the admin rooms when demoted', async () => {
    await userService.updateUserRole(userOne._id, 'participant')
    expect(evictSpy).toHaveBeenCalledWith(userOne._id.toString())
  })

  it('does not evict when the new role still moderates', async () => {
    await userService.updateUserRole(userOne._id, 'admin')
    expect(evictSpy).not.toHaveBeenCalled()
  })

  it('still saves the role if the eviction fails', async () => {
    evictSpy.mockRejectedValue(new Error('adapter down'))
    const user = await userService.updateUserRole(userOne._id, 'participant')
    expect(user.role).toBe('participant')
  })
})

describe('websocketGateway.evictFromAdminRooms', () => {
  afterEach(() => {
    websocketGateway.worker = null
  })

  it('asks the worker to evict when running on the primary, since only workers hold sockets', async () => {
    const send = jest.fn()
    websocketGateway.worker = { send } as never
    await websocketGateway.evictFromAdminRooms('user-a')
    expect(send).toHaveBeenCalledWith({ evictAdminRoomsFor: 'user-a' })
  })
})
