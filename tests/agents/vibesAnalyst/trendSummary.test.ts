import buildTrendSummary from '../../../src/agents/vibesAnalyst/trendSummary.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms, TrendSnapshotView } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

/* Three sessions of the same series with participation clearly climbing, so the model has a
   real trend to describe. Snapshots arrive newest-first, the way the resolver returns them. */
function risingSeries(): TrendSnapshotView[] {
  const base = (name: string, endTime: string, posterCount: number, lurkerCount: number): TrendSnapshotView => ({
    eventName: name,
    eventEndTime: new Date(endTime),
    posterCount,
    messageCount: posterCount * 8,
    lurkerCount,
    participationRate: posterCount / (posterCount + lurkerCount),
    avgDwellSeconds: 900,
    spikeCount: 1,
    channelSplit: { public: posterCount * 8, private: 0 }
  })
  return [
    base('AI Ethics Session 3', '2026-05-30T00:00:00.000Z', 24, 16),
    base('AI Ethics Session 2', '2026-05-15T00:00:00.000Z', 16, 18),
    base('AI Ethics Session 1', '2026-05-01T00:00:00.000Z', 9, 20)
  ]
}

describe('buildTrendSummary', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('writes a comparative card with a header, standouts, and a poster-per-event chart', async () => {
    const card = await buildTrendSummary(risingSeries(), llm)

    expect(card.header).toBeTruthy()
    expect(card.standouts.length).toBeGreaterThanOrEqual(1)
    expect(card.standouts.length).toBeLessThanOrEqual(3)

    // The first standout carries the deterministic posters-per-event chart, oldest to newest.
    const { visual } = card.standouts[0]
    expect(visual).toBeDefined()
    if (!visual || visual.chart.type === 'pie') throw new Error('expected a line/bar chart on the first standout')
    expect(visual.chart.series[0].data.map((point) => point.value)).toEqual([9, 16, 24])
  })
})
