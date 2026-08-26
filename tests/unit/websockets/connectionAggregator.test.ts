import createConnectionAggregator from '../../../src/websockets/connectionAggregator.js'

describe('connectionAggregator', () => {
  it('starts at zero with no workers reporting', () => {
    const aggregator = createConnectionAggregator()
    expect(aggregator.getTotal()).toBe(0)
  })

  it('sums the latest reported count per worker', () => {
    const aggregator = createConnectionAggregator()
    aggregator.onMessage(1, { type: 'connectionCount', count: 3 })
    aggregator.onMessage(2, { type: 'connectionCount', count: 4 })
    expect(aggregator.getTotal()).toBe(7)

    // A later report from the same worker replaces, not adds to, its count.
    aggregator.onMessage(1, { type: 'connectionCount', count: 5 })
    expect(aggregator.getTotal()).toBe(9)
  })

  it('ignores messages of a different type', () => {
    const aggregator = createConnectionAggregator()
    aggregator.onMessage(1, { type: 'somethingElse', count: 99 })
    expect(aggregator.getTotal()).toBe(0)
  })

  it('treats a missing count as zero', () => {
    const aggregator = createConnectionAggregator()
    aggregator.onMessage(1, { type: 'connectionCount' })
    expect(aggregator.getTotal()).toBe(0)
  })

  it('drops a worker\'s count when it exits, instead of leaving it stale forever', () => {
    const aggregator = createConnectionAggregator()
    aggregator.onMessage(1, { type: 'connectionCount', count: 10 })
    aggregator.onMessage(2, { type: 'connectionCount', count: 5 })
    expect(aggregator.getTotal()).toBe(15)

    aggregator.onExit(1)
    // Without this, worker 1's last count would keep inflating the total
    // this instance publishes, holding extra autoscaled capacity it no
    // longer needs.
    expect(aggregator.getTotal()).toBe(5)
  })

  it('is a no-op to exit a worker that never reported', () => {
    const aggregator = createConnectionAggregator()
    aggregator.onMessage(1, { type: 'connectionCount', count: 10 })

    aggregator.onExit(2)
    expect(aggregator.getTotal()).toBe(10)
  })
})
