import { buildTrendChart, trendRow } from '../../../../src/agents/vibesAnalyst/trendSummary.js'
import { TrendSnapshotView } from '../../../../src/types/index.types.js'

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

  it('plots poster count per event as a line, in the given (chronological) order', () => {
    const visual = buildTrendChart(ordered)

    if (visual.chart.type === 'pie') throw new Error('expected a line chart')

    // line is a valid data_visualization chart type and reads as a trend over time. The type was
    // never why the block was rejected; the label length was (see the next test).
    expect(visual.chart.type).toBe('line')

    expect(visual.chart.series).toHaveLength(1)
    expect(visual.chart.series[0].data.map((point) => point.value)).toEqual([8, 12, 20])
    // Categories line up with the series points, one per event, in order.
    expect(visual.chart.axisConfig.categories).toHaveLength(3)
    expect(visual.chart.series[0].data.map((point) => point.label)).toEqual(visual.chart.axisConfig.categories)
  })

  it("keeps every category and data point label within Slack's 20-character limit", () => {
    // The real cause of the invalid_blocks rejection: Slack caps each data point label and each
    // axis category at 20 characters, and a full "Name (date)" label runs well past that. Every
    // data point label must also match a category, or the block is rejected.
    const longName = snap('Regenerative Futures Monthly Roundtable', '2026-06-10T00:00:00.000Z', 5)
    const visual = buildTrendChart([longName, ...ordered])
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')

    for (const category of visual.chart.axisConfig.categories) {
      expect(category.length).toBeLessThanOrEqual(20)
    }
    for (const point of visual.chart.series[0].data) {
      expect(point.label.length).toBeLessThanOrEqual(20)
      expect(visual.chart.axisConfig.categories).toContain(point.label)
    }
  })

  it('labels each event by its short date and keeps categories unique', () => {
    const visual = buildTrendChart(ordered)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const { categories } = visual.chart.axisConfig
    expect(categories[0]).toBe('May 1')
    expect(categories[2]).toBe('May 30')
    expect(new Set(categories).size).toBe(3)
  })

  it('disambiguates events that fall on the same date so categories stay unique', () => {
    const sameDay = [
      snap('Morning Session', '2026-05-01T09:00:00.000Z', 4),
      snap('Evening Session', '2026-05-01T18:00:00.000Z', 7)
    ]
    const visual = buildTrendChart(sameDay)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const { categories } = visual.chart.axisConfig
    expect(new Set(categories).size).toBe(2)
    for (const category of categories) expect(category.length).toBeLessThanOrEqual(20)
  })
})

describe('trendRow', () => {
  it('passes through every metric the snapshot carries and drops identity and version fields', () => {
    const snapshot = {
      eventName: 'AI Ethics 3',
      eventEndTime: new Date('2026-05-30T00:00:00.000Z'),
      posterCount: 20,
      messageCount: 200,
      lurkerCount: 5,
      participationRate: 0.8,
      avgDwellSeconds: 300,
      spikeCount: 2,
      channelSplit: { public: 180, private: 20 },
      // Metrics added to the snapshot later must reach the writer without changing trendRow.
      actionBreakdown: { 'command:visual': 9 },
      privateMessageCount: 20,
      distinctPrivateSenders: 4,
      distinctPublicSenders: 16,
      activeVisitorCount: 18,
      // Identity and version bookkeeping that should never be handed to the writer.
      _id: 'snap-id',
      __v: 0,
      conversationId: 'conv-1',
      topicId: 'topic-1',
      metricsVersion: 1,
      capturedAt: new Date('2026-05-31T00:00:00.000Z')
    } as unknown as TrendSnapshotView

    const row = trendRow(snapshot)

    expect(row.event).toContain('AI Ethics 3')
    expect(row.actionBreakdown).toEqual({ 'command:visual': 9 })
    expect(row.privateMessageCount).toBe(20)
    expect(row.distinctPrivateSenders).toBe(4)
    expect(row.channelSplit).toEqual({ public: 180, private: 20 })

    for (const dropped of ['conversationId', 'topicId', 'metricsVersion', '_id', '__v', 'eventName', 'eventEndTime']) {
      expect(row).not.toHaveProperty(dropped)
    }
  })

  it('reads a Mongoose document through toObject', () => {
    const doc = {
      toObject: () => ({
        eventName: 'Doc Event',
        eventEndTime: new Date('2026-05-30T00:00:00.000Z'),
        posterCount: 7,
        privateMessageCount: 3,
        _id: 'doc-id',
        conversationId: 'conv-2'
      })
    } as unknown as TrendSnapshotView

    const row = trendRow(doc)

    expect(row.event).toContain('Doc Event')
    expect(row.posterCount).toBe(7)
    expect(row.privateMessageCount).toBe(3)
    expect(row).not.toHaveProperty('conversationId')
    expect(row).not.toHaveProperty('_id')
  })
})
