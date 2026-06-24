import { computeSpikes, TimedActivityBucket } from '../../../src/services/conversationAnalytics.service.js'

/* Builds one 10-minute bucket starting at the given minute offset. The width is
   fixed because the spike rule only cares about counts, not window length. */
function bucket(startMinute: number, messageCount: number): TimedActivityBucket {
  return { startMinute, endMinute: startMinute + 10, messageCount }
}

/* Six evenly spaced buckets across an hour, one per ten minutes, from a list of
   counts. Mirrors the shape computeConversationMetrics feeds in. */
function sixBuckets(counts: number[]): TimedActivityBucket[] {
  return counts.map((count, index) => bucket(index * 10, count))
}

describe('computeSpikes', () => {
  it('flags a bucket that clears both the relative multiple and the floor', () => {
    const spikes = computeSpikes(sixBuckets([2, 2, 18, 2, 2, 2]), 10)

    expect(spikes).toHaveLength(1)
    expect(spikes[0]).toMatchObject({ label: '20-29', startMinute: 20, endMinute: 30, messageCount: 18 })
    expect(spikes[0].ratio).toBeCloseTo(9)
  })

  it('does not flag a flat distribution', () => {
    expect(computeSpikes(sixBuckets([5, 5, 5, 5, 5, 5]), 10)).toEqual([])
  })

  it('still detects a spike in a small event, where a few messages is a real burst', () => {
    const spikes = computeSpikes(sixBuckets([0, 1, 0, 4, 1, 0]), 4)

    expect(spikes).toHaveLength(1)
    expect(spikes[0]).toMatchObject({ startMinute: 30, messageCount: 4 })
  })

  it('ignores a bump below the absolute floor', () => {
    expect(computeSpikes(sixBuckets([0, 1, 0, 2, 0, 0]), 4)).toEqual([])
  })

  it('returns no spikes when there are fewer than three buckets', () => {
    expect(computeSpikes([bucket(0, 5), bucket(10, 40)], 10)).toEqual([])
  })

  it('reports a null ratio when the rest of the event was silent', () => {
    const spikes = computeSpikes(sixBuckets([0, 0, 9, 0, 0, 0]), 5)

    expect(spikes).toHaveLength(1)
    expect(spikes[0].baselineAverage).toBe(0)
    expect(spikes[0].ratio).toBeNull()
  })

  it('selects only the single busiest window when the baseline is zero', () => {
    // [3,0,0]: all the messages land in one window and the rest are empty, so the
    // baseline is zero everywhere. The multiple test is meaningless against a zero
    // baseline, so only the single busiest window that clears the floor comes back.
    const spikes = computeSpikes([bucket(0, 3), bucket(10, 0), bucket(20, 0)], 5)

    expect(spikes).toHaveLength(1)
    expect(spikes[0]).toMatchObject({ startMinute: 0, messageCount: 3 })
  })

  it('reports no spike on a zero baseline when the busiest window is below the floor', () => {
    // The whole event is a single two-message window. Raw selection still must clear
    // the floor, so a two-message blip is not a spike even with a silent rest.
    const spikes = computeSpikes([bucket(0, 2), bucket(10, 0), bucket(20, 0)], 5)

    expect(spikes).toEqual([])
  })

  it('detects multiple spikes in chronological order', () => {
    const spikes = computeSpikes(sixBuckets([10, 1, 1, 1, 1, 12]), 10)

    expect(spikes.map((s) => s.startMinute)).toEqual([0, 50])
  })

  it('scales the floor with participant count, so the same burst spikes a small event but not a large one', () => {
    const counts = [1, 1, 1, 1, 1, 9]

    expect(computeSpikes(sixBuckets(counts), 4)).toHaveLength(1)
    expect(computeSpikes(sixBuckets(counts), 100)).toEqual([])
  })
})
