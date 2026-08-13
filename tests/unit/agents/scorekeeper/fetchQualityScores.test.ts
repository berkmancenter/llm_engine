/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals'

// Async generator helper — mimics what LangSmith SDK returns for list* methods
async function* asyncItems<T>(items: T[]) {
  for (const item of items) yield item
}

const mockListRuns = jest.fn<(...args: any[]) => any>()
const mockListFeedback = jest.fn<(...args: any[]) => any>()
const mockGetRunUrl = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('langsmith', () => ({
  Client: jest.fn().mockImplementation(() => ({
    listRuns: mockListRuns,
    listFeedback: mockListFeedback,
    getRunUrl: mockGetRunUrl
  }))
}))

// Import config before fetchQualityScores so we can control langsmith settings
const config = ((await import('../../../../src/config/config.js')).default) as any
const { fetchQualityScores } = await import('../../../../src/agents/scorekeeper/fetchQualityScores.js')

const RUN_1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const RUN_2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const RUN_3 = 'aaaaaaaa-0000-0000-0000-000000000003'

function makeFeedback(runId: string, key: string, score: number) {
  return { run_id: runId, key, score }
}

describe('fetchQualityScores()', () => {
  const originalLangsmith = { key: config.langsmith?.key, project: config.langsmith?.project }

  beforeEach(() => {
    jest.clearAllMocks()
    config.langsmith.key = 'test-key'
    config.langsmith.project = 'test-project'
    mockGetRunUrl.mockResolvedValue('https://smith.langchain.com/runs/test')
  })

  afterEach(() => {
    config.langsmith.key = originalLangsmith.key
    config.langsmith.project = originalLangsmith.project
  })

  it('returns null when LangSmith key is not configured', async () => {
    config.langsmith.key = ''
    const result = await fetchQualityScores('conv-1')
    expect(result).toBeNull()
  })

  it('returns null when LangSmith project is not configured', async () => {
    config.langsmith.project = ''
    const result = await fetchQualityScores('conv-1')
    expect(result).toBeNull()
  })

  it('returns null when no traces exist for the conversation', async () => {
    mockListRuns.mockReturnValue(asyncItems([]))
    const result = await fetchQualityScores('conv-1')
    expect(result).toBeNull()
  })

  it('returns null when traces exist but none have feedback', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([]))
    const result = await fetchQualityScores('conv-1')
    expect(result).toBeNull()
  })

  it('computes per-evaluator mean correctly', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }, { id: RUN_2 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'quality.correctness', 0.8),
      makeFeedback(RUN_2, 'quality.correctness', 0.6)
    ]))

    const result = await fetchQualityScores('conv-1')
    const evaluator = result!.evaluators.find((e) => e.key === 'quality.correctness')!

    expect(evaluator.mean).toBeCloseTo(0.7)
    expect(evaluator.count).toBe(2)
  })

  it('computes per-evaluator min correctly', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }, { id: RUN_2 }, { id: RUN_3 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'compliance.tone', 0.9),
      makeFeedback(RUN_2, 'compliance.tone', 0.3),
      makeFeedback(RUN_3, 'compliance.tone', 0.7)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.evaluators[0].min).toBeCloseTo(0.3)
  })

  it('counts per-evaluator lowScoreCount for scores below 0.5', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }, { id: RUN_2 }, { id: RUN_3 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'compliance.tone', 0.8),
      makeFeedback(RUN_2, 'compliance.tone', 0.4),
      makeFeedback(RUN_3, 'compliance.tone', 0.2)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.evaluators[0].lowScoreCount).toBe(2)
  })

  it('computes overall mean as mean of per-key means', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'quality.correctness', 0.8),
      makeFeedback(RUN_1, 'compliance.tone', 0.6)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.overallMean).toBeCloseTo(0.7)
  })

  it('sets tracesScored to number of runs that received feedback, not total traces listed', async () => {
    // 3 runs listed, but only 2 get feedback
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }, { id: RUN_2 }, { id: RUN_3 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'quality.correctness', 0.8),
      makeFeedback(RUN_2, 'quality.correctness', 0.6)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.tracesScored).toBe(2)
  })

  it('identifies a trace as low-score when any evaluator score is below 0.5', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'quality.correctness', 0.9),
      makeFeedback(RUN_1, 'compliance.tone', 0.3)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.totalLowScoreCount).toBe(1)
    expect(result!.lowScoreTraces).toHaveLength(1)
    expect(result!.lowScoreTraces[0].runId).toBe(RUN_1)
    expect(result!.lowScoreTraces[0].lowScores).toEqual([{ key: 'compliance.tone', score: 0.3 }])
  })

  it('does not flag a trace when all scores are at or above 0.5', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'quality.correctness', 0.5),
      makeFeedback(RUN_1, 'compliance.tone', 0.8)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.totalLowScoreCount).toBe(0)
    expect(result!.lowScoreTraces).toHaveLength(0)
  })

  it('sorts low-score traces worst-first', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }, { id: RUN_2 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'compliance.tone', 0.4),
      makeFeedback(RUN_2, 'compliance.tone', 0.1)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.lowScoreTraces[0].runId).toBe(RUN_2)
    expect(result!.lowScoreTraces[1].runId).toBe(RUN_1)
  })

  it('caps lowScoreTraces at 5 but reports the true total in totalLowScoreCount', async () => {
    const runs = Array.from({ length: 8 }, (_, i) => ({ id: `run-${i}` }))
    mockListRuns.mockReturnValue(asyncItems(runs))
    mockListFeedback.mockReturnValue(asyncItems(
      runs.map((r) => makeFeedback(r.id, 'compliance.tone', 0.1))
    ))

    const result = await fetchQualityScores('conv-1')
    expect(result!.lowScoreTraces).toHaveLength(5)
    expect(result!.totalLowScoreCount).toBe(8)
  })

  it('attaches a LangSmith URL to each low-score trace', async () => {
    const url = 'https://smith.langchain.com/runs/abc'
    mockGetRunUrl.mockResolvedValue(url)
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([makeFeedback(RUN_1, 'compliance.tone', 0.2)]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.lowScoreTraces[0].url).toBe(url)
  })

  it('sets url to null when getRunUrl throws', async () => {
    mockGetRunUrl.mockRejectedValue(new Error('not found'))
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([makeFeedback(RUN_1, 'compliance.tone', 0.2)]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.lowScoreTraces[0].url).toBeNull()
  })

  it('skips feedback entries with null score', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      { run_id: RUN_1, key: 'quality.correctness', score: null },
      makeFeedback(RUN_1, 'compliance.tone', 0.8)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.evaluators).toHaveLength(1)
    expect(result!.evaluators[0].key).toBe('compliance.tone')
  })

  it('sorts evaluators alphabetically by key', async () => {
    mockListRuns.mockReturnValue(asyncItems([{ id: RUN_1 }]))
    mockListFeedback.mockReturnValue(asyncItems([
      makeFeedback(RUN_1, 'quality.correctness', 0.8),
      makeFeedback(RUN_1, 'compliance.tone', 0.7),
      makeFeedback(RUN_1, 'accuracy.factual', 0.9)
    ]))

    const result = await fetchQualityScores('conv-1')
    expect(result!.evaluators.map((e) => e.key)).toEqual([
      'accuracy.factual',
      'compliance.tone',
      'quality.correctness'
    ])
  })
})
