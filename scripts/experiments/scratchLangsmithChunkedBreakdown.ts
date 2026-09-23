/* eslint-disable no-console */
/* Chunked per-agent token/cost breakdown over a long window. getRunStats(filter/traceFilter)
   combined with a long startTime window silently undercounts (verified empirically: a 60d
   filtered query summed to ~53% of the unfiltered 60d total, while the same filtered query
   over a 7d window reconciled exactly against the unfiltered 7d total). Chunking into 7-day
   windows and summing avoids the bug. */
import 'dotenv/config'
import { Client } from 'langsmith'

const PROJECT = process.argv[2] ?? 'llmEngine'
const DAYS = Number(process.argv[3] ?? 60)
const CHUNK_DAYS = 7
const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

const AGENT_NAMES = [
  'eventAssistant',
  'proactiveGroupAgent',
  'moderatorNotifier',
  'librarian',
  'communityAssistant',
  'RunnableSequence',
  'jargonFilterAgent',
  'vibesAnalyst',
  'conversationSummary',
  'voiceAssistant',
  'scorekeeper',
  'numberCruncher',
  'backChannelInsights'
]

type Row = { name: string; calls: number; prompt: number; completion: number; cost: number }

async function main() {
  const now = Date.now()
  const chunks: { start: Date; end: Date }[] = []
  for (let d = 0; d < DAYS; d += CHUNK_DAYS) {
    const end = new Date(now - d * 24 * 60 * 60 * 1000)
    const start = new Date(now - Math.min(d + CHUNK_DAYS, DAYS) * 24 * 60 * 60 * 1000)
    chunks.push({ start, end })
  }
  console.log(`Project: ${PROJECT}, ${DAYS}d in ${chunks.length} chunks of up to ${CHUNK_DAYS}d`)

  const totals = new Map<string, Row>()
  for (const { start, end } of chunks) {
    console.log(`chunk ${start.toISOString()} .. ${end.toISOString()}`)
    for (const name of AGENT_NAMES) {
      const stats = (await client.getRunStats({
        projectNames: [PROJECT],
        runType: 'llm',
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        traceFilter: `eq(name, "${name}")`
      })) as Record<string, number>
      const row = totals.get(name) ?? { name, calls: 0, prompt: 0, completion: 0, cost: 0 }
      row.calls += stats.run_count ?? 0
      row.prompt += stats.prompt_tokens ?? 0
      row.completion += stats.completion_tokens ?? 0
      row.cost += stats.total_cost ?? 0
      totals.set(name, row)
    }
  }

  const rows = [...totals.values()].sort((a, b) => b.cost - a.cost)
  const sumCost = rows.reduce((s, r) => s + r.cost, 0)
  const sumPrompt = rows.reduce((s, r) => s + r.prompt, 0)
  console.log('')
  console.log('=== Final per-agent totals (chunked, should reconcile with project total) ===')
  for (const r of rows) {
    console.log(
      `${r.name}: ${
        r.calls
      } llm calls, ${r.prompt.toLocaleString()} prompt tok, ${r.completion.toLocaleString()} completion tok, ` +
        `$${r.cost.toFixed(2)} (${((r.cost / sumCost) * 100).toFixed(1)}%), avg prompt/call=${Math.round(
          r.prompt / Math.max(r.calls, 1)
        ).toLocaleString()}`
    )
  }
  console.log('')
  console.log(`sum cost=$${sumCost.toFixed(2)}, sum prompt tokens=${sumPrompt.toLocaleString()}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
