import { dropUnbackedCharts } from '../../../../src/agents/vibesAnalyst/verifyCuration.js'
import { buildChartCandidates } from '../../../../src/agents/vibesAnalyst/curate.js'
import { ConversationMetrics, CuratedVibesData } from '../../../../src/types/index.types.js'
import makeMetrics from '../../../utils/metricsFixture.js'

/* Minimal metrics with enough to build at least the activity and channel-split
   charts, so the test can attach a real chart and a fabricated one. */
function metricsFixture(): ConversationMetrics {
  return makeMetrics({
    activitySeries: [
      { label: '0-10', messageCount: 5 },
      { label: '10-20', messageCount: 15 },
      { label: '20-30', messageCount: 30 }
    ],
    participationHistory: [],
    baseline: null
  })
}

describe('dropUnbackedCharts', () => {
  it('keeps a chart that matches one built from the metrics', () => {
    const metrics = metricsFixture()
    const candidates = buildChartCandidates(metrics)

    const card: CuratedVibesData = {
      header: 'Test event recap',
      standouts: [
        { text: 'Activity climbed late', visual: { title: candidates.activity.title, chart: candidates.activity.chart } }
      ],
      durationMinutes: 30
    }

    const result = dropUnbackedCharts(card, metrics)

    expect(result.standouts[0].visual).toBeDefined()
    expect(result.standouts[0].visual!.chart).toEqual(candidates.activity.chart)
  })

  it('strips a chart whose data does not come from the metrics, keeping the prose', () => {
    const metrics = metricsFixture()

    const card: CuratedVibesData = {
      header: 'Test event recap',
      standouts: [
        {
          text: 'A made-up surge',
          visual: {
            title: 'Messages over time',
            // Values here exist nowhere in the metrics, so this chart is unbacked.
            chart: {
              type: 'bar',
              series: [{ name: 'Messages', data: [{ label: '0-10', value: 999 }] }],
              axisConfig: { categories: ['0-10'], yLabel: 'Messages' }
            }
          }
        }
      ],
      durationMinutes: 30
    }

    const result = dropUnbackedCharts(card, metrics)

    expect(result.standouts[0].visual).toBeUndefined()
    expect(result.standouts[0].text).toBe('A made-up surge')
  })

  it('leaves a text-only standout untouched', () => {
    const metrics = metricsFixture()

    const card: CuratedVibesData = {
      header: 'Test event recap',
      standouts: [{ text: 'Half the registrants spoke up' }],
      durationMinutes: 30
    }

    const result = dropUnbackedCharts(card, metrics)

    expect(result.standouts[0]).toEqual({ text: 'Half the registrants spoke up' })
  })
})
