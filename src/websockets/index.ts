import http from 'http'
import cluster from 'node:cluster'
import { setupMaster } from '@socket.io/sticky'
import { setupPrimary } from '@socket.io/cluster-adapter'
import config from '../config/config.js'
import socketIO from './socketIO.js'
import registerMessageHandlers from './handlers/messageHandlers.js'
import registerConversationHandlers from './handlers/conversationHandlers.js'
import gateway from './websocketGateway.js'
import { getRoomIds } from './utils.js'

// Initialize an empty worker variable to take
// the primary cluster instance for the rest of the
// app to use to send messages to child processes with.
// eslint-disable-next-line import/no-mutable-exports
let worker
if (cluster.isPrimary) {
  const httpServer = http.createServer()
  const numCPUs = config.websocketMaxParallelism
  // create one worker per available core
  if (config.env !== 'test') {
    for (let i = 1; i <= numCPUs; i += 1) {
      worker = cluster.fork({
        PORT: config.websocketBasePort + i
      })
    }
  }
  gateway.worker = worker
  setupMaster(httpServer, {
    loadBalancingMethod: 'least-connection' // either "random", "round-robin" or "least-connection"
  })
  setupPrimary()
  if (config.env !== 'test') {
    httpServer.listen(config.websocketBasePort)
  }
} else {
  const httpServer = http.createServer()
  socketIO.init(httpServer)
  const io = socketIO.getConnection()
  io.addConnectionHandlers([registerMessageHandlers, registerConversationHandlers])

  // receive messages from the rest of the app and pass them on to every
  // child process' socket io instance
  process.on('message', (message: { conversation: string; event: string; message: string; channels?: string[] }) => {
    if (message.conversation) {
      const roomIds = getRoomIds(message.conversation, message.channels)
      io.emitMultiple(roomIds, message.event, message.message)
    }
  })
}
export default worker
