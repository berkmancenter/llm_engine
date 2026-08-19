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
import reportConcurrentConnections from '../utils/gcpConnectionMetrics.js'

// How often each worker reports its own connection count up to the primary,
// and how often the primary aggregates those and reports the instance
// total to Cloud Monitoring. Worker reports run more often than the
// primary's publish interval so the primary's picture stays fresh.
//
// These intervals are the dominant term in how fast the autoscaler can react,
// because this metric is its primary signal (see infra/modules/webserver-mig/
// autoscaler.tf) and CPU is only a fallback. At the previous 60s publish /30s
// report they were slow enough to miss the event they exist to catch: in a
// 2026-08-19 load test, 1,000 connections were established in ~14 seconds and
// the published series still read "1" for the following two minutes, only
// reaching 1001 about 100 seconds after the connections actually existed. The
// autoscaler cannot respond to a burst it has not been told about, so the
// group did not begin growing until the arrival spike was long over.
//
// Shortened so the signal tracks arrivals rather than trailing them. This does
// not make scaling fast enough to absorb a burst on its own - instance boot is
// still tens of seconds behind - but it stops the measurement itself being the
// largest delay in the loop. Cost is one time-series write per instance per
// interval, which is negligible next to what it buys.
const CONNECTION_COUNT_REPORT_INTERVAL_MS = 5_000
const CONNECTION_METRIC_PUBLISH_INTERVAL_MS = 10_000

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

    // Aggregate each worker's self-reported connection count and publish
    // the instance total — see ../utils/gcpConnectionMetrics.ts. Skipped
    // entirely (no IPC listener, no timer) unless opted into via
    // ENABLE_GCP_CONNECTION_METRICS, not just left to no-op downstream.
    if (config.enableGcpConnectionMetrics) {
      const connectionCountsByWorkerId = new Map<number, number>()
      cluster.on('message', (fromWorker, message: { type?: string; count?: number }) => {
        if (message?.type === 'connectionCount') {
          connectionCountsByWorkerId.set(fromWorker.id, message.count ?? 0)
        }
      })
      setInterval(() => {
        const total = [...connectionCountsByWorkerId.values()].reduce((sum, count) => sum + count, 0)
        reportConcurrentConnections(total)
      }, CONNECTION_METRIC_PUBLISH_INTERVAL_MS)
    }
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

  if (config.env !== 'test' && config.enableGcpConnectionMetrics) {
    setInterval(() => {
      process.send?.({ type: 'connectionCount', count: io.io?.engine.clientsCount ?? 0 })
    }, CONNECTION_COUNT_REPORT_INTERVAL_MS)
  }
}
export default worker
