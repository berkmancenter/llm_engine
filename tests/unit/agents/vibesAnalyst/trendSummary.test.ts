import { buildTrendChart, TrendSnapshotView } from '../../../../src/agents/vibesAnalyst/trendSummary.js'

function snap(name: string, endTime: string, posterCount: number): TrendSnapshotView {
  return {
    eventName: name,
    eventEndTime: new Date(endTime),
    posterCount,
    messageCount: posterCount * 10,
    lurkerCount: null,
    participationRate: null,
    avgDwellSeconds: null,
    spikeCount: 0,
    channelSplit: { public: posterCount * 10, private: 0 }
  }
}

describe('buildTrendChart', () => {
  const ordered = [
    snap('AI Ethics Session 1', '2026-05-01T00:00:00.000Z', 8),
    snap('AI Ethics Session 2', '2026-05-15T00:00:00.000Z', 12),
    snap('AI Ethics Session 3', '2026-05-30T00:00:00.000Z', 20)
  ]

  it('plots poster count per event in the given (chronological) order', () => {
    const visual = buildTrendChart(ordered)

    expect(visual.chart.type).not.toBe('pie')
    if (visual.chart.type === 'pie') throw new Error('expected a line/bar chart')

    expect(visual.chart.series).toHaveLength(1)
    expect(visual.chart.series[0].data.map((point) => point.value)).toEqual([8, 12, 20])
    // Categories line up with the series points, one per event, in order.
    expect(visual.chart.axisConfig.categories).toHaveLength(3)
    expect(visual.chart.series[0].data.map((point) => point.label)).toEqual(visual.chart.axisConfig.categories)
  })

  it('labels each event by name and date so a repeated series name stays distinguishable', () => {
    const visual = buildTrendChart(ordered)
    if (visual.chart.type === 'pie') throw new Error('expected a line/bar chart')
    const { categories } = visual.chart.axisConfig
    expect(categories[0]).toContain('May 1')
    expect(categories[2]).toContain('May 30')
    expect(new Set(categories).size).toBe(3)
  })
})
