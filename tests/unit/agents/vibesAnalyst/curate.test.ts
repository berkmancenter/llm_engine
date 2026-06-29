import { buildChartCandidates } from '../../../../src/agents/vibesAnalyst/curate.js'
import { ConversationMetrics, CuratedVibesChart } from '../../../../src/types/index.types.js'

/* Metrics rich enough to build the trend and baseline charts (a two-point history and
   a baseline). audienceEngagement defaults to null (no tracked-session data), so a test
   opts into the audience split by overriding it. */
function metricsFixture(overrides: Partial<ConversationMetrics> = {}): ConversationMetrics {
  return {
    participation: { posterCount: 20, frequentPosterCount: 2, frequentPosterMessageShare: 0.4, messageCount: 50 },
    trackedSessionSources: [],
    trackedSessionStatus: 'notTracked',
    audienceEngagement: null,
    activitySeries: [
      { label: '0-10', messageCount: 5 },
      { label: '10-20', messageCount: 15 }
    ],
    participationHistory: [
      { label: 'E1', posterCount: 18, lurkerCount: null },
      { label: 'Today', posterCount: 20, lurkerCount: null }
    ],
    baseline: { eventCount: 3, trackedEventCount: 0, avgPosterCount: 18, avgLurkerCount: null, avgDwellSeconds: null },
    channelSplit: { public: 30, private: 20 },
    ...overrides
  }
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

  it('offers the posters-vs-lurkers split only when tracked-session data exists', () => {
    expect(buildChartCandidates(metricsFixture({ audienceEngagement: null })).audienceSplit).toBeUndefined()

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

  it('omits the posters-vs-lurkers split when posters exceed tracked sessions', () => {
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
})
