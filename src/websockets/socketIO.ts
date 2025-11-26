import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/cluster-adapter'
import { setupWorker } from '@socket.io/sticky'
import logger from '../config/logger.js'

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
      adapter: createAdapter()
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
