import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/cluster-adapter'
import { setupWorker } from '@socket.io/sticky'
import logger from '../config/logger.js'
import { getModeratorTrackerRoomId, isAdminRoom } from './utils.js'

let conn
class SocketIO {
  public io: Server | null

  constructor() {
    this.io = null
  }

  connect(server) {
    this.io = new Server(server, {
      cors: {
        origin: '*'
      },
      connectionStateRecovery: {},
      // set up the adapter on each worker conversation
      adapter: createAdapter(),
      maxHttpBufferSize: 5e6 // 5 MB - supports base64 images from visual responses
    })

    this.io.adapter(createAdapter())
    setupWorker(this.io)
  }

  emit(room: string, event, data) {
    this.io!.in(room).emit(event, data)
  }

  emitMultiple(rooms: string[], event, data) {
    this.io!.in(rooms).emit(event, data)
  }

  /**
   * Take every socket of this user out of every admin room. Admin-room membership is granted once, at join, from the
   * role the user had then; nothing re-checks it per emit, so it has to be revoked when the role changes. Runs
   * cluster-wide (fetchSockets goes through the adapter), so it reaches sockets held by other workers.
   */
  async evictFromAdminRooms(userId: string) {
    const trackerRoom = getModeratorTrackerRoomId(userId)
    const sockets = await this.io!.in(trackerRoom).fetchSockets()
    for (const socket of sockets) {
      for (const room of socket.rooms) {
        if (isAdminRoom(room) || room === trackerRoom) socket.leave(room)
      }
    }
    logger.info(`Evicted ${sockets.length} socket(s) of user ${userId} from admin rooms`)
  }

  addConnectionHandlers(handlers) {
    this.io!.on('connection', (socket) => {
      logger.debug('Socket connecting.')
      for (const handler of handlers) {
        handler(this.io, socket)
      }
    })
  }

  static init(server) {
    if (!conn) {
      conn = new SocketIO()
      conn.connect(server)
    }
  }

  static getConnection() {
    if (conn) {
      return conn
    }
  }
}

export default SocketIO
