import { jest } from '@jest/globals'
import { TrendSnapshotView } from '../../../../src/types/index.types.js'

/* buildTrendSummary's only LLM dependency is the curation call that writes the header and
   standout prose; the chart and the JSON handed to that call are both built deterministically
   from the same `ordered` array. Mocking the call lets the "chart matches the data the writer
   saw" tests run without an LLM, and run every time rather than only when an agent test suite
   hits a real model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

const {
  default: buildTrendSummary,
  buildTrendChart,
  trendRow
} = await import('../../../../src/agents/vibesAnalyst/trendSummary.js')

function snap(name: string, endTime: string, posterCount: number): TrendSnapshotView {
  return {
    name,
    endTime: new Date(endTime),
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
      name: 'AI Ethics 3',
      endTime: new Date('2026-05-30T00:00:00.000Z'),
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

    for (const dropped of ['conversationId', 'topicId', 'metricsVersion', '_id', '__v', 'name', 'endTime']) {
      expect(row).not.toHaveProperty(dropped)
    }
  })

  it('reads a Mongoose document through toObject', () => {
    const doc = {
      toObject: () => ({
        name: 'Doc Event',
        endTime: new Date('2026-05-30T00:00:00.000Z'),
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

describe('buildTrendSummary', () => {
  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
    mockGetChatPromptResponse.mockResolvedValue({
      header: 'Engagement across the last 3 sessions',
      standouts: [{ text: 'Participation rose across the series.' }]
    })
  })

  /* The resolver hands snapshots to buildTrendSummary newest-first (fetchTrendSnapshots sorts
     descending, and computeTrendViewsLive preserves that candidate order); this is a rising
     series in real chronological order, so newest-first is [24, 16, 9]. */
  const newestFirst = [
    snap('AI Ethics Session 3', '2026-05-30T00:00:00.000Z', 24),
    snap('AI Ethics Session 2', '2026-05-15T00:00:00.000Z', 16),
    snap('AI Ethics Session 1', '2026-05-01T00:00:00.000Z', 9)
  ]

  it("plots the chart oldest-to-newest, matching the order the writer's prose describes", async () => {
    const card = await buildTrendSummary(newestFirst, {})

    const { visual } = card.standouts[0]
    if (!visual || visual.chart.type === 'pie') throw new Error('expected a line/bar chart on the first standout')
    // Chronological, left to right: the earliest (smallest) event first, the latest (largest)
    // last, so a rising series reads as a rising line rather than a falling one.
    expect(visual.chart.series[0].data.map((point) => point.value)).toEqual([9, 16, 24])
  })

  it('hands the writer the same oldest-to-newest rows the chart was built from', async () => {
    await buildTrendSummary(newestFirst, {})

    const [, , , templateVars] = mockGetChatPromptResponse.mock.calls[0]
    const rows = JSON.parse(templateVars.metricsJson)
    // The writer's prompt promises "oldest first"; the rows must actually arrive in that order,
    // the same order the chart plots, so the two can never describe opposite directions.
    expect(rows.map((row) => row.posterCount)).toEqual([9, 16, 24])
  })
})
