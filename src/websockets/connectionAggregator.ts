// Aggregates each cluster worker's self-reported connection count into an
// instance-wide total for ../utils/gcpConnectionMetrics.ts to publish.
//
// Pulled out of index.ts as a plain factory with no cluster/EventEmitter
// dependency of its own, so the aggregation logic — including worker-exit
// cleanup — is unit-testable via plain function calls instead of needing
// real cluster workers. See tests/unit/websockets/connectionAggregator.test.ts.
export default function createConnectionAggregator() {
  const connectionCountsByWorkerId = new Map<number, number>()

  return {
    onMessage(workerId: number, message: { type?: string; count?: number }) {
      if (message?.type === 'connectionCount') {
        connectionCountsByWorkerId.set(workerId, message.count ?? 0)
      }
    },
    // A crashed/exited worker's last-reported count would otherwise sit
    // in the map forever, inflating the aggregated total this instance
    // publishes and holding extra autoscaled capacity it no longer needs.
    onExit(workerId: number) {
      connectionCountsByWorkerId.delete(workerId)
    },
    getTotal(): number {
      return [...connectionCountsByWorkerId.values()].reduce((sum, count) => sum + count, 0)
    }
  }
}
