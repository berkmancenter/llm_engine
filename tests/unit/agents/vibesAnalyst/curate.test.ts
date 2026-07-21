import { buildChartCandidates } from '../../../../src/agents/vibesAnalyst/curate.js'
import { ConversationMetrics, CuratedVibesChart, TrackedSessionMetrics } from '../../../../src/types/index.types.js'
import makeMetrics from '../../../utils/metricsFixture.js'

/* A tracked-session source with the given breakdown maps, so a test can opt into the
   device and feature-usage charts that only appear when a source carries data. */
function trackedSource(overrides: Partial<TrackedSessionMetrics> = {}): TrackedSessionMetrics {
  return {
    source: 'matomo',
    capturedAt: new Date('2026-06-10T18:05:00.000Z'),
    trackedSessions: 90,
    attendeeCount: 80,
    avgDwellSeconds: 420,
    totalActions: 950,
    deviceBreakdown: {},
    actionBreakdown: {},
    actionUserBreakdown: {},
    activeVisitorCount: 0,
    actionBreakdownPerActiveVisitor: {},
    ...overrides
  }
}

/* Metrics rich enough to build the trend and baseline charts (a two-point history and
   a baseline). audienceEngagement defaults to the no-direct-channel-data mismatch case
   (0 participants against 20 posters), so a test opts into the audience split by
   overriding it with a reconciled count. */
function metricsFixture(overrides: Partial<ConversationMetrics> = {}): ConversationMetrics {
  return makeMetrics(overrides)
}

/* The number of data series on a bar/line chart (pie charts have none). */
function seriesCount(candidate: { chart: CuratedVibesChart } | undefined): number {
  const chart = candidate?.chart
  if (chart && (chart.type === 'bar' || chart.type === 'line')) return chart.series.length
  return 0
}

describe('buildChartCandidates', () => {
  it('always offers the activity and channel-split charts', () => {
    const candidates = buildChartCandidates(metricsFixture())

    expect(candidates.activity).toBeDefined()
    expect(candidates.channelSplit).toBeDefined()
  })

  it('offers the posters trend and posters-vs-baseline charts when there is history and a baseline', () => {
    const candidates = buildChartCandidates(metricsFixture())

    expect(candidates.engagementHistory).toBeDefined()
    expect(candidates.postersVsBaseline).toBeDefined()
  })

  it('offers the posters-vs-lurkers split only when the participant count reconciles', () => {
    expect(buildChartCandidates(metricsFixture()).audienceSplit).toBeUndefined()

    const tracked = buildChartCandidates(
      metricsFixture({
        audienceEngagement: {
          participantCount: 100,
          lurkerCount: 80,
          participationRate: 0.2,
          postersExceedTrackedSessions: false
        }
      })
    )

    expect(tracked.audienceSplit).toBeDefined()
  })

  it('omits the posters-vs-lurkers split when posters exceed direct-channel participants', () => {
    const mismatched = buildChartCandidates(
      metricsFixture({
        audienceEngagement: {
          participantCount: 1,
          lurkerCount: null,
          participationRate: null,
          postersExceedTrackedSessions: true
        }
      })
    )

    expect(mismatched.audienceSplit).toBeUndefined()
  })

  it('adds a lurkers series to the trend only when every event in it has tracked data', () => {
    const allTracked = buildChartCandidates(
      metricsFixture({
        participationHistory: [
          { label: 'E1', posterCount: 18, lurkerCount: 40 },
          { label: 'Today', posterCount: 20, lurkerCount: 50 }
        ]
      })
    )
    expect(seriesCount(allTracked.engagementHistory)).toBe(2)

    const someUntracked = buildChartCandidates(
      metricsFixture({
        participationHistory: [
          { label: 'E1', posterCount: 18, lurkerCount: null },
          { label: 'Today', posterCount: 20, lurkerCount: 50 }
        ]
      })
    )
    expect(seriesCount(someUntracked.engagementHistory)).toBe(1)
  })

  it('offers the poster-mix split of one-time versus repeat posters when anyone posted', () => {
    const candidates = buildChartCandidates(
      metricsFixture({
        participation: { posterCount: 20, frequentPosterCount: 2, frequentPosterMessageShare: 0.4, messageCount: 50 },
        participationConcentration: {
          topPosterCount: 3,
          topPosterMessageShare: 0.3,
          oneTimePosterCount: 14,
          repeatPosterCount: 6
        }
      })
    )

    expect(candidates.posterMix).toBeDefined()
    const { chart } = candidates.posterMix!
    expect(chart.type).toBe('pie')
    if (chart.type === 'pie') {
      expect(chart.segments).toEqual([
        { label: 'Posted once', value: 14 },
        { label: 'Posted more than once', value: 6 }
      ])
    }
  })

  it('omits the poster-mix split when no one posted', () => {
    const candidates = buildChartCandidates(
      metricsFixture({
        participation: { posterCount: 0, frequentPosterCount: 0, frequentPosterMessageShare: 0, messageCount: 0 },
        participationConcentration: {
          topPosterCount: 0,
          topPosterMessageShare: null,
          oneTimePosterCount: 0,
          repeatPosterCount: 0
        }
      })
    )

    expect(candidates.posterMix).toBeUndefined()
  })

  it('offers a feature-usage bar chart only when the first source has a non-empty action breakdown', () => {
    expect(buildChartCandidates(metricsFixture()).featureUsage).toBeUndefined()
    expect(buildChartCandidates(metricsFixture({ trackedSessionSources: [trackedSource()] })).featureUsage).toBeUndefined()

    const candidates = buildChartCandidates(
      metricsFixture({
        trackedSessionSources: [trackedSource({ actionBreakdown: { 'command:visual': 20, 'tab:chat': 10 } })]
      })
    )

    expect(candidates.featureUsage).toBeDefined()
    const { chart } = candidates.featureUsage!
    expect(chart.type).toBe('bar')
    if (chart.type === 'bar') {
      expect(chart.series[0].data).toEqual([
        { label: 'command:visual', value: 20 },
        { label: 'tab:chat', value: 10 }
      ])
    }
  })
})
