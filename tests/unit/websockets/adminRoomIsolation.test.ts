import { createServer } from 'http'
import { AddressInfo } from 'net'
import { Server } from 'socket.io'
import ioClient from 'socket.io-client'
import { getAdminRoomId, getRoomId } from '../../../src/websockets/utils.js'

/**
 * Real socket.io rooms: a client in a channel literally named "admin" must not receive traffic sent
 * to the admin-only room, and the other way round.
 */
describe('admin room cannot be aliased by a channel named admin', () => {
  const conversation = '6ad68fa30914be7fe464298e'
  let server
  let io: Server
  let channelClient
  let adminClient

  beforeAll(async () => {
    server = createServer()
    io = new Server(server)
    io.on('connection', (socket) => {
      socket.on('join', (room, ack) => {
        socket.join(room)
        ack()
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(resolve)
    })
    const { port } = server.address() as AddressInfo
    channelClient = ioClient(`http://localhost:${port}`)
    adminClient = ioClient(`http://localhost:${port}`)
    await Promise.all(
      [
        [channelClient, getRoomId(conversation, 'admin')],
        [adminClient, getAdminRoomId(conversation)]
      ].map(
        ([client, room]) =>
          new Promise<void>((resolve) => {
            client.emit('join', room, resolve)
          })
      )
    )
  })

  afterAll(async () => {
    channelClient.close()
    adminClient.close()
    io.close()
    await new Promise((resolve) => {
      server.close(resolve)
    })
  })

  it('uses different room names', () => {
    expect(getAdminRoomId(conversation)).not.toBe(getRoomId(conversation, 'admin'))
    expect(getAdminRoomId(conversation)).toBe(`admin:${conversation}`)
  })

  it('delivers admin-room traffic to the admin client only, and channel traffic to the channel client only', async () => {
    const received: string[] = []
    channelClient.on('hidden', () => received.push('channel:hidden'))
    adminClient.on('hidden', () => received.push('admin:hidden'))
    channelClient.on('chat', () => received.push('channel:chat'))
    adminClient.on('chat', () => received.push('admin:chat'))

    io.in([getAdminRoomId(conversation)]).emit('hidden')
    io.in([getRoomId(conversation, 'admin')]).emit('chat')
    await new Promise((resolve) => {
      setTimeout(resolve, 300)
    })

    expect(received.sort()).toEqual(['admin:hidden', 'channel:chat'])
  })
})
