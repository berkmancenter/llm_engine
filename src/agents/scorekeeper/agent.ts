import verify from '../helpers/verify.js'
import { defaultLLMModel, defaultLLMPlatform } from '../helpers/getModelChat.js'
import { AgentMessageActions } from '../../types/index.types.js'
import type { QualityReportData } from '../../types/index.types.js'
import logger from '../../config/logger.js'
import Conversation from '../../models/conversation.model.js'
import QualityReport from '../../models/qualityReport.model.js'
import { fetchQualityScores } from './fetchQualityScores.js'

function midnightUtc(): Date {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function twentyFourHoursAgo(): Date {
  return new Date(Date.now() - 24 * 60 * 60 * 1000)
}

function thirtyDaysAgo(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
}

const BASELINE_MIN_SAMPLES = 5

async function fetchBaseline(
  excludeConversationId: string
): Promise<{ deltas: Record<string, number>; sampleCount: number } | null> {
  const reports = await QualityReport.find({
    conversationId: { $ne: excludeConversationId },
    reportDate: { $gte: thirtyDaysAgo() }
  })
    .select('evaluators')
    .lean()

  if (reports.length < BASELINE_MIN_SAMPLES) return null

  const accumulated = new Map<string, { total: number; count: number }>()
  for (const report of reports) {
    for (const e of report.evaluators) {
      const agg = accumulated.get(e.key) ?? { total: 0, count: 0 }
      agg.total += e.mean
      agg.count += 1
      accumulated.set(e.key, agg)
    }
  }

  const baseline: Record<string, number> = {}
  for (const [key, { total, count }] of accumulated) {
    baseline[key] = total / count
  }

  return { deltas: baseline, sampleCount: reports.length }
}

export default verify({
  name: 'Scorekeeper',
  description:
    'Nightly sweep agent. Fetches LangSmith evaluator feedback scores for all conversations that ended today and returns a quality report card per conversation',
  priority: 100,
  maxTokens: undefined,
  defaultTriggers: {
    cron: { expression: '0 4 * * *' }
  },
  llmTemplateVars: undefined,
  defaultLLMTemplates: undefined,
  defaultLLMPlatform,
  defaultLLMModel,
  ragCollectionName: undefined,

  async start() {
    return true
  },

  async stop() {
    return true
  },

  async introduce() {
    return []
  },

  async evaluate(userMessage = null) {
    return {
      userMessage,
      action: AgentMessageActions.CONTRIBUTE,
      userContributionVisible: true,
      suggestion: undefined
    }
  },

  async respond() {
    const reportDate = midnightUtc()

    const conversations = await Conversation.find({
      endTime: { $gte: twentyFourHoursAgo() },
      $expr: { $gt: ['$endTime', '$startTime'] },
      draft: false
    })
      .select('_id name topic')
      .populate('topic', 'private')
      .lean()

    if (conversations.length === 0) {
      logger.debug('scorekeeper: no conversations ended today')
      return []
    }

    const responses: object[] = []

    for (const conversation of conversations) {
      const conversationId = conversation._id.toString()

      const existing = await QualityReport.findOne({ conversationId: conversation._id, reportDate })
      if (existing) {
        logger.debug(`scorekeeper: report already exists for ${conversationId}`)
        continue
      }

      const topic = conversation.topic as { private?: boolean } | undefined
      const topicIsPrivate = topic?.private !== false
      const displayName = topicIsPrivate ? 'a private conversation' : conversation.name

      const scores = await fetchQualityScores(conversationId)
      if (!scores) continue

      const baseline = await fetchBaseline(conversationId)
      const deltas: Record<string, number> | undefined = baseline
        ? Object.fromEntries(
            scores.evaluators
              .filter((e) => baseline.deltas[e.key] !== undefined)
              .map((e) => [e.key, e.mean - baseline.deltas[e.key]])
          )
        : undefined

      await QualityReport.create({
        conversationId: conversation._id,
        conversationName: displayName,
        reportDate,
        evaluators: scores.evaluators,
        overallMean: scores.overallMean,
        tracesScored: scores.tracesScored,
        totalLowScoreCount: scores.totalLowScoreCount
      })

      const renderData: QualityReportData = {
        conversationName: displayName,
        conversationId,
        evaluators: scores.evaluators,
        overallMean: scores.overallMean,
        tracesScored: scores.tracesScored,
        lowScoreTraces: scores.lowScoreTraces,
        totalLowScoreCount: scores.totalLowScoreCount,
        generatedAt: new Date().toISOString(),
        deltas,
        baselineSampleCount: baseline?.sampleCount
      }

      responses.push({
        visible: true,
        message: `Quality report for ${displayName}: overall ${scores.overallMean.toFixed(2)} across ${
          scores.tracesScored
        } traces`,
        messageType: 'text' as const,
        responseKind: 'qualityReport' as const,
        renderData,
        channels: this.conversation.channels
      })
    }

    return responses
  }
})
