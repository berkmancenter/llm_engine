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
    } as unknown as TrendSnapshotView)
  return [
    base('Fancy Vibes Session 3', '2026-06-30T00:00:00.000Z', 12, 12, 0.98),
    base('Fancy Vibes Session 2', '2026-06-16T00:00:00.000Z', 8, 8, 0.96),
    base('Fancy Vibes Session 1', '2026-06-02T00:00:00.000Z', 5, 5, 0.27)
  ]
}

/* The exact shape of the reported bug: three same-day sessions whose real chronology (by endTime)
   runs 12 -> 8 -> 5 posters, a decline, but whose names carry ascending ordinals (#1, #2, #3) that
   point the other way. The event the series calls "#1" is actually the most recent, "#3" the
   oldest, so a reader who trusts the name's number instead of the stated oldest-first order reads
   the trend backwards. Every metric here moves down or holds flat, so nothing in this fixture
   legitimately rose: any rising verb in the output is the model narrating against the data. Same
   newest-first arrival order the resolver returns; buildTrendSummary re-sorts by endTime. */
function decliningSeriesWithContradictoryNames(): TrendSnapshotView[] {
  const base = (name: string, endTime: string, posterCount: number, lurkerCount: number) =>
    ({
      name,
      endTime: new Date(endTime),
      posterCount,
      messageCount: posterCount * 10,
      lurkerCount,
      participationRate: 0.5,
      avgDwellSeconds: 700,
      spikeCount: 1,
      channelSplit: { public: posterCount * 10, private: 0 }
    } as unknown as TrendSnapshotView)
  return [
    base('Test Fancy Vibes #1', '2026-07-01T05:37:28.968Z', 5, 5),
    base('Test Fancy Vibes #2', '2026-07-01T05:36:56.792Z', 8, 8),
    base('Test Fancy Vibes #3', '2026-07-01T05:36:05.714Z', 12, 12)
  ]
}

/* Direction verbs. The bug makes the writer say posters "rose"; the truth is they "fell". With a
   fixture where nothing actually increases, a rising verb anywhere in the prose is the bug. */
const RISING =
  /\b(rose|rise|rising|grew|grow(?:ing|s|n)?|climb(?:ed|ing|s)?|increas\w*|doubl\w*|expand\w*|surg\w*|jump\w*)\b/i
const FALLING =
  /\b(fell|fall\w*|declin\w*|drop\w*|shr\w*|fewer|halv\w*|slid|slipp?\w*|dwindl\w*|contract\w*|sank|sunk|dip\w*)\b/i

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

    const prose = [card.header, card.framing, ...card.standouts.map((standout) => standout.text)].filter(Boolean).join(' ')

    for (const jargon of BANNED_JARGON) {
      expect(prose).not.toMatch(jargon)
    }
  })

  it('narrates the poster trend in true chronological order even when event names carry a contradictory ordinal', async () => {
    const card = await buildTrendSummary(decliningSeriesWithContradictoryNames(), llm)

    // The chart is deterministic and already correct: oldest-to-newest is 12 -> 8 -> 5.
    const { visual } = card.standouts[0]
    if (!visual || visual.chart.type === 'pie') throw new Error('expected a line/bar chart on the first standout')
    expect(visual.chart.series[0].data.map((point) => point.value)).toEqual([12, 8, 5])

    const prose = [card.header, card.framing, ...card.standouts.map((standout) => standout.text)].filter(Boolean).join(' ')

    // The prose must follow that same decline. Nothing in this fixture rose, so a rising verb means
    // the writer reordered by the "#1/#2/#3" name ordinal instead of the stated oldest-first order.
    expect(prose).not.toMatch(RISING)
    expect(prose).toMatch(FALLING)
  })
})
