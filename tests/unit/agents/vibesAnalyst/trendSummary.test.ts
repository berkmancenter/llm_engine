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
    // axis category at 20 characters, and a long event name runs well past that, so it is truncated.
    // Every data point label must also match a category, or the block is rejected.
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

  it('labels each event by its name, keeping the ordinal that tells sibling events apart', () => {
    const visual = buildTrendChart(ordered)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const { categories } = visual.chart.axisConfig
    expect(categories).toEqual(['AI Ethics Session 1', 'AI Ethics Session 2', 'AI Ethics Session 3'])
    expect(new Set(categories).size).toBe(3)
  })

  it('falls back to the date when an event has no name', () => {
    const unnamed = [
      { ...snap('', '2026-05-01T12:00:00.000Z', 4), name: undefined },
      { ...snap('', '2026-05-30T12:00:00.000Z', 7), name: undefined }
    ] as unknown as TrendSnapshotView[]
    const visual = buildTrendChart(unnamed)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    expect(visual.chart.axisConfig.categories).toEqual(['May 1', 'May 30'])
  })

  it('marks a truncated name with an ellipsis', () => {
    const longName = [snap('Regenerative Futures Monthly Roundtable', '2026-05-01T00:00:00.000Z', 4)]
    const visual = buildTrendChart(longName)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const [label] = visual.chart.axisConfig.categories
    expect(label).toBe('Regenerative Futu...')
    expect(label.length).toBe(20)
  })

  it('tags events that share a name with their shorthand date, dropping the year within one year', () => {
    const sharedName = [
      snap('Regenerative Futures Monthly Roundtable', '2026-05-01T12:00:00.000Z', 4),
      snap('Regenerative Futures Monthly Roundtable', '2026-05-30T12:00:00.000Z', 7)
    ]
    const visual = buildTrendChart(sharedName)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const { categories } = visual.chart.axisConfig
    // A bare shared name collides, which the block rejects; the date tells the two events apart. Both
    // fall in 2026, so the year is dropped and the truncated name keeps its ellipsis.
    expect(new Set(categories).size).toBe(2)
    expect(categories[0]).toBe('Regenerat... (05/01)')
    expect(categories[1]).toBe('Regenerat... (05/30)')
  })

  it('keeps the year on the date tag when the chart straddles a year boundary', () => {
    const acrossYears = [snap('Sync', '2025-12-15T12:00:00.000Z', 4), snap('Sync', '2026-01-12T12:00:00.000Z', 7)]
    const visual = buildTrendChart(acrossYears)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const { categories } = visual.chart.axisConfig
    expect(categories).toEqual(['Sync (12/15/25)', 'Sync (01/12/26)'])
  })

  it('keeps categories unique even when two events share both a name and a day', () => {
    const twins = [snap('Standup', '2026-05-01T09:00:00.000Z', 3), snap('Standup', '2026-05-01T18:00:00.000Z', 6)]
    const visual = buildTrendChart(twins)
    if (visual.chart.type === 'pie') throw new Error('expected a line chart')
    const { categories } = visual.chart.axisConfig
    // Same name and same day: the date cannot separate them, so a last-resort counter must.
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

  it('adds a 1-based order field when given the row index, and none without one', () => {
    const snapshot = {
      name: 'Session 2',
      endTime: new Date('2026-05-15T00:00:00.000Z'),
      posterCount: 8
    } as TrendSnapshotView

    expect(trendRow(snapshot, 0).order).toBe(1)
    expect(trendRow(snapshot, 2).order).toBe(3)
    expect(trendRow(snapshot)).not.toHaveProperty('order')
  })

  it('drops a trailing series ordinal from the label so the writer cannot read it as a timeline', () => {
    const at = (name: string) =>
      trendRow({ name, endTime: new Date('2026-05-01T12:00:00.000Z'), posterCount: 1 } as TrendSnapshotView).event

    // A same-series "#N" or "<word> N" tail is the bug's trigger; the base name is what remains.
    expect(at('Test Fancy Vibes #3')).toBe('Test Fancy Vibes (May 1)')
    expect(at('AI Ethics Session 2')).toBe('AI Ethics (May 1)')
    expect(at('Standup - Part 3')).toBe('Standup (May 1)')
    expect(at('Book Club Vol. IV')).toBe('Book Club (May 1)')
  })

  it('keeps a number that is part of a distinct title, not a trailing sequence marker', () => {
    const at = (name: string) =>
      trendRow({ name, endTime: new Date('2026-05-01T12:00:00.000Z'), posterCount: 1 } as TrendSnapshotView).event

    // These carry real identity for a compare-different-events trend; stripping would corrupt them.
    expect(at('Web3 Meetup')).toBe('Web3 Meetup (May 1)')
    expect(at('Catch-22')).toBe('Catch-22 (May 1)')
    expect(at('2026 Kickoff')).toBe('2026 Kickoff (May 1)')
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

  /* A blind reverse only works when the caller's array is genuinely newest-first. Two events
     landing on the same day (or any other tie in the upstream sort) can leave the array in an
     order that does not match true chronology, and a real LLM narrating from each row's own
     name and date (not its array position) will still get the story right while a chart that
     merely reversed whatever it was given would plot the wrong direction. This is exactly the
     reported bug: text says rising, chart shows falling. Sorting by endTime here, rather than
     trusting the caller's order, is what actually fixes it. */
  it('plots correctly even when the input array is not in chronological order at all', async () => {
    const scrambled = [
      snap('Fancy Vibes Session 2', '2026-05-15T00:00:00.000Z', 16),
      snap('Fancy Vibes Session 1', '2026-05-01T00:00:00.000Z', 9),
      snap('Fancy Vibes Session 3', '2026-05-30T00:00:00.000Z', 24)
    ]

    const card = await buildTrendSummary(scrambled, {})

    const { visual } = card.standouts[0]
    if (!visual || visual.chart.type === 'pie') throw new Error('expected a line/bar chart on the first standout')
    expect(visual.chart.series[0].data.map((point) => point.value)).toEqual([9, 16, 24])

    const [, , , templateVars] = mockGetChatPromptResponse.mock.calls[0]
    const rows = JSON.parse(templateVars.metricsJson)
    expect(rows.map((row) => row.posterCount)).toEqual([9, 16, 24])
  })
})
