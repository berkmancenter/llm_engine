import { Client } from 'langsmith'
import config from '../../config/config.js'
import logger from '../../config/logger.js'

export interface EvaluatorScore {
  key: string
  mean: number
  min: number
  count: number
  lowScoreCount: number
}

export interface LowScoreTrace {
  runId: string
  url: string | null
  lowScores: Array<{ key: string; score: number }>
}

export interface QualityScores {
  evaluators: EvaluatorScore[]
  overallMean: number
  tracesScored: number
  lowScoreTraces: LowScoreTrace[]
  totalLowScoreCount: number
}

const LOW_SCORE_THRESHOLD = 0.5
const MAX_LOW_SCORE_TRACES = 5

function conversationFilter(conversationId: string): string {
  return `and(eq(metadata_key, "conversationId"), eq(metadata_value, "${conversationId}"))`
}

/**
 * Fetches LangSmith feedback scores for all root traces tagged with the given
 * conversationId. Aggregates per evaluator key and computes per-key and overall
 * means. Also surfaces the worst-scoring traces where any evaluator scored below
 * LOW_SCORE_THRESHOLD, with direct LangSmith links. Returns null if LangSmith is
 * not configured or no scored traces exist.
 */
export async function fetchQualityScores(conversationId: string): Promise<QualityScores | null> {
  if (!config.langsmith.key || !config.langsmith.project) {
    logger.debug('scorekeeper: LangSmith key or project not configured; skipping')
    return null
  }

  const client = new Client({ apiKey: config.langsmith.key })

  try {
    const runIds: string[] = []
    for await (const run of client.listRuns({
      projectName: config.langsmith.project,
      isRoot: true,
      filter: conversationFilter(conversationId)
    })) {
      runIds.push(String(run.id))
    }

    if (runIds.length === 0) {
      logger.debug(`scorekeeper: no traces found for conversation ${conversationId}`)
      return null
    }

    // accumulated[key] = { total, count, min, lowScoreCount } for aggregation
    const accumulated = new Map<string, { total: number; count: number; min: number; lowScoreCount: number }>()
    // perRun[runId][key] = score, for per-trace low-score detection
    const perRun = new Map<string, Map<string, number>>()

    for await (const feedback of client.listFeedback({ runIds })) {
      if (feedback.score == null || !feedback.run_id) continue
      const { key } = feedback
      const score = Number(feedback.score)
      const runId = String(feedback.run_id)

      const agg = accumulated.get(key) ?? { total: 0, count: 0, min: Infinity, lowScoreCount: 0 }
      agg.total += score
      agg.count += 1
      agg.min = Math.min(agg.min, score)
      if (score < LOW_SCORE_THRESHOLD) agg.lowScoreCount += 1
      accumulated.set(key, agg)

      const runScores = perRun.get(runId) ?? new Map<string, number>()
      runScores.set(key, score)
      perRun.set(runId, runScores)
    }

    if (accumulated.size === 0) {
      logger.debug(`scorekeeper: no feedback scores found for conversation ${conversationId}`)
      return null
    }

    const evaluators: EvaluatorScore[] = [...accumulated.entries()]
      .map(([key, { total, count, min, lowScoreCount }]) => ({ key, mean: total / count, min, count, lowScoreCount }))
      .sort((a, b) => a.key.localeCompare(b.key))

    const overallMean = evaluators.reduce((sum, e) => sum + e.mean, 0) / evaluators.length

    // Find traces with any score below the threshold, sorted worst-first
    const lowScoreEntries = [...perRun.entries()]
      .map(([runId, scores]) => ({
        runId,
        lowScores: [...scores.entries()]
          .filter(([, score]) => score < LOW_SCORE_THRESHOLD)
          .map(([key, score]) => ({ key, score }))
          .sort((a, b) => a.score - b.score)
      }))
      .filter((e) => e.lowScores.length > 0)
      .sort((a, b) => a.lowScores[0].score - b.lowScores[0].score)

    const totalLowScoreCount = lowScoreEntries.length
    const lowScoreTraces: LowScoreTrace[] = await Promise.all(
      lowScoreEntries.slice(0, MAX_LOW_SCORE_TRACES).map(async ({ runId, lowScores }) => {
        let url: string | null = null
        try {
          url = await client.getRunUrl({ runId, projectOpts: { projectName: config.langsmith.project } })
        } catch {
          logger.debug(`scorekeeper: could not build URL for run ${runId}`)
        }
        return { runId, url, lowScores }
      })
    )

    return { evaluators, overallMean, tracesScored: perRun.size, lowScoreTraces, totalLowScoreCount }
  } catch (error) {
    logger.error(`scorekeeper: LangSmith fetch failed for ${conversationId}`, error)
    return null
  }
}
