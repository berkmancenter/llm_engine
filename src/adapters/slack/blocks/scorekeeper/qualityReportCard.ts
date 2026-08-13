import type { KnownBlock } from '@slack/types'
import type { QualityReportData, QualityReportEvaluatorScore, QualityReportLowScoreTrace } from '../../../../types/index.types.js'

const SEPARATOR_WIDTH = 46
const DELTA_MIN_DISPLAY = 0.02
const TRENDING_DOWN_THRESHOLD = -0.10

function scoreBar(mean: number): string {
  const filled = Math.round(mean * 10)
  const empty = 10 - filled
  return '█'.repeat(filled) + '░'.repeat(empty)
}

function trafficLight(mean: number): string {
  if (mean >= 0.7) return '🟢'
  if (mean >= 0.5) return '🟡'
  return '🔴'
}

function formatName(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function parseKey(fullKey: string): { category: string; name: string } {
  const dot = fullKey.indexOf('.')
  if (dot === -1) return { category: '', name: fullKey }
  return { category: fullKey.slice(0, dot), name: fullKey.slice(dot + 1) }
}

function deltaStr(delta: number): string {
  if (Math.abs(delta) < DELTA_MIN_DISPLAY) return '→'
  return delta > 0 ? `↑ +${delta.toFixed(2)}` : `↓ ${delta.toFixed(2)}`
}

function scoreRow(e: QualityReportEvaluatorScore, delta?: number): string {
  const { name } = parseKey(e.key)
  const label = formatName(name).padEnd(28)
  const trend = delta !== undefined ? `  ${deltaStr(delta)}` : ''
  return `${trafficLight(e.mean)} ${label} ${e.mean.toFixed(2)}  ${scoreBar(e.mean)}${trend}`
}

function buildScoreTable(evaluators: QualityReportEvaluatorScore[], deltas?: Record<string, number>): string {
  const groupMap = new Map<string, QualityReportEvaluatorScore[]>()

  for (const e of evaluators) {
    const { category } = parseKey(e.key)
    const group = groupMap.get(category) ?? []
    group.push(e)
    groupMap.set(category, group)
  }

  // Named categories alphabetically, uncategorized (empty string) last
  const sorted = [...groupMap.keys()].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b)
  })

  const lines: string[] = []
  for (const category of sorted) {
    const entries = groupMap.get(category)!
    if (category) {
      if (lines.length > 0) lines.push('')
      const dashes = '─'.repeat(Math.max(0, SEPARATOR_WIDTH - category.length - 4))
      lines.push(`── ${category} ${dashes}`)
    }
    for (const e of entries) {
      lines.push(scoreRow(e, deltas?.[e.key]))
    }
  }

  return lines.join('\n')
}

function lowScoreLine(o: QualityReportLowScoreTrace): string {
  const scores = o.lowScores.map(({ key, score }) => {
    const { name } = parseKey(key)
    return `${formatName(name)}: ${score.toFixed(2)}`
  }).join(', ')
  const link = o.url ? `<${o.url}|view trace>` : `run \`${o.runId.slice(0, 8)}\``
  return `• ${link} — ${scores}`
}

export default function renderQualityReportCard(data: QualityReportData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:bar_chart: Quality Report: ${data.conversationName}`, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Overall: ${data.overallMean.toFixed(2)}* · ${data.tracesScored} traces scored`
      }
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `\`\`\`\n${buildScoreTable(data.evaluators, data.deltas)}\n\`\`\``
      }
    }
  ]

  if (data.deltas) {
    const trendingDown = data.evaluators
      .filter((e) => (data.deltas![e.key] ?? 0) <= TRENDING_DOWN_THRESHOLD)
      .sort((a, b) => data.deltas![a.key] - data.deltas![b.key])

    if (trendingDown.length > 0) {
      const lines = trendingDown.map((e) => {
        const { name } = parseKey(e.key)
        const d = data.deltas![e.key]
        return `• ${formatName(name)}: ${e.mean.toFixed(2)} (${d.toFixed(2)} vs avg)`
      })
      blocks.push({ type: 'divider' })
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*:chart_with_downwards_trend: Trending Down*\n${lines.join('\n')}`
        }
      })
    }
  }

  if (data.lowScoreTraces.length > 0) {
    const shown = data.lowScoreTraces.length
    const total = data.totalLowScoreCount
    const suffix = total > shown ? ` · showing worst ${shown} of ${total}` : ''
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*:warning: Needs Review* (${total} trace${total === 1 ? '' : 's'} with scores below 0.5${suffix})\n${data.lowScoreTraces.map(lowScoreLine).join('\n')}`
      }
    })
  }

  blocks.push({ type: 'divider' })

  const generatedAt = new Date(data.generatedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  })

  const baselineNote = data.baselineSampleCount !== undefined
    ? ` · Trends vs. 30-day avg (${data.baselineSampleCount} reports)`
    : ''

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Generated at ${generatedAt} · Scores from LangSmith online evaluators${baselineNote}` }]
  })

  return blocks
}
