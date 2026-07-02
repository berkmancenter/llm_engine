import buildTrendSummary from '../../../src/agents/vibesAnalyst/trendSummary.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { LlmPlatforms, TrendSnapshotView } from '../../../src/types/index.types.js'

jest.setTimeout(45000) // LLM calls can be slow

/* Three sessions of the same series with participation clearly climbing, so the model has a
   real trend to describe. Snapshots arrive newest-first, the way the resolver returns them. */
function risingSeries(): TrendSnapshotView[] {
  const base = (name: string, endTime: string, posterCount: number, lurkerCount: number): TrendSnapshotView => ({
    name,
    endTime: new Date(endTime),
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

/* Mirrors the real session that prompted the jargon complaint: posters climbing 5 -> 8 -> 12,
   participation rate flat around 50%, and frequentPosterMessageShare swinging from a long tail
   (27%) to a small core of regulars (96%+). A stored snapshot carries more fields than the
   narrow TrendSnapshotView type declares (trendRow passes through whatever the document has),
   so this fixture is cast the same way trendSummary's own trendRow tests do. */
function mixedShareSeries(): TrendSnapshotView[] {
  const base = (
    name: string,
    endTime: string,
    posterCount: number,
    lurkerCount: number,
    frequentPosterMessageShare: number
  ) =>
    ({
      name,
      endTime: new Date(endTime),
      posterCount,
      messageCount: posterCount * 10,
      lurkerCount,
      participationRate: posterCount / (posterCount + lurkerCount),
      avgDwellSeconds: 700,
      spikeCount: 1,
      channelSplit: { public: posterCount * 10, private: 0 },
      frequentPosterMessageShare
    }) as unknown as TrendSnapshotView
  return [
    base('Fancy Vibes Session 3', '2026-06-30T00:00:00.000Z', 12, 12, 0.98),
    base('Fancy Vibes Session 2', '2026-06-16T00:00:00.000Z', 8, 8, 0.96),
    base('Fancy Vibes Session 1', '2026-06-02T00:00:00.000Z', 5, 5, 0.27)
  ]
}

/* Literal jargon this prompt was rewritten to avoid: raw field-name identifiers, and the exact
   ugly compound nouns a host flagged as unreadable ("frequent-poster message share",
   "lurker-to-poster ratio"). A plain-language rewrite should never reproduce these. */
const BANNED_JARGON = [
  /frequentPosterMessageShare/i,
  /participationRate/i,
  /lurkerCount/i,
  /frequent-poster message share/i,
  /lurker-to-poster ratio/i
]

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

  it('describes a shifting frequent-poster share in plain language, not raw field names or jargon compounds', async () => {
    const card = await buildTrendSummary(mixedShareSeries(), llm)

    const prose = [card.header, card.framing, ...card.standouts.map((standout) => standout.text)]
      .filter(Boolean)
      .join(' ')

    for (const jargon of BANNED_JARGON) {
      expect(prose).not.toMatch(jargon)
    }
  })
})
