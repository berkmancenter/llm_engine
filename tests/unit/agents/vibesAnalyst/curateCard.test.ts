import { jest } from '@jest/globals'
import { ConversationMetrics, TrackedSessionMetrics } from '../../../../src/types/index.types.js'
import makeMetrics from '../../../utils/metricsFixture.js'

/* buildChartCandidates is unit-tested elsewhere. Here the whole curateVibesCard runs against a
   mocked model to pin the surfacing seam: naming a chart key attaches the real computed chart
   rather than the model's numbers, and naming a key we never offered attaches nothing. The model
   call is the only LLM dependency, so it is the only mock. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

const { default: curateVibesCard } = await import('../../../../src/agents/vibesAnalyst/curate.js')

function trackedSource(overrides: Partial<TrackedSessionMetrics> = {}): TrackedSessionMetrics {
  return {
    source: 'matomo',
    capturedAt: new Date('2026-06-10T18:05:00.000Z'),
    trackedSessions: 90,
    attendeeCount: 80,
    avgDwellSeconds: 420,
    totalActions: 950,
    deviceBreakdown: {},
    actionBreakdown: { 'command:visual': 20, 'tab:chat': 10 },
    actionUserBreakdown: { 'command:visual': 8, 'tab:chat': 6 },
    activeVisitorCount: 40,
    actionBreakdownPerActiveVisitor: { 'command:visual': 0.5, 'tab:chat': 0.25 },
    ...overrides
  }
}

function metricsFixture(): ConversationMetrics {
  return makeMetrics({
    trackedSessionSources: [trackedSource()],
    trackedSessionStatus: 'available',
    audienceEngagement: {
      participantCount: 80,
      lurkerCount: 60,
      participationRate: 0.25,
      postersExceedTrackedSessions: false
    }
  })
}

describe('curateVibesCard surfacing', () => {
  const llm = { fake: true }

  beforeEach(() => {
    mockGetChatPromptResponse.mockReset()
  })

  it('attaches the real feature-usage and channel-split charts when the model selects those keys', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      header: 'Heavy on visuals',
      state: 'positive',
      standouts: [
        { text: '*command:visual* led the feature use', chartKey: 'featureUsage', caption: 'Feature usage' },
        { text: 'Most messages went to public chat', chartKey: 'channelSplit' }
      ]
    })

    const card = await curateVibesCard(metricsFixture(), { eventName: 'Demo', durationMinutes: 40 }, llm)

    const feature = card.standouts.find((standout) => standout.visual?.title === 'Feature usage (tracked sessions)')
    expect(feature?.visual).toBeDefined()
    expect(feature!.visual!.caption).toBe('Feature usage')
    const featureChart = feature!.visual!.chart
    expect(featureChart.type).toBe('bar')
    if (featureChart.type === 'bar') {
      // The chart carries the computed action counts, not anything the model supplied.
      expect(featureChart.series[0].data).toEqual([
        { label: 'command:visual', value: 20 },
        { label: 'tab:chat', value: 10 }
      ])
    }

    const channel = card.standouts.find((standout) => standout.visual?.title === 'Where messages went')
    expect(channel?.visual?.chart.type).toBe('pie')
  })

  it('attaches no chart when the model names a key that was never offered', async () => {
    mockGetChatPromptResponse.mockResolvedValue({
      header: 'Quiet one',
      state: 'quiet',
      standouts: [{ text: 'nothing to chart', chartKey: 'doesNotExist' }, { text: 'plain line, no chart' }]
    })

    const card = await curateVibesCard(metricsFixture(), { eventName: 'Demo', durationMinutes: 10 }, llm)

    expect(card.standouts).toHaveLength(2)
    expect(card.standouts.every((standout) => standout.visual === undefined)).toBe(true)
  })
})
