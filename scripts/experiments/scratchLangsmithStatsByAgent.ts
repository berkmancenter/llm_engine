/* eslint-disable no-console */
import 'dotenv/config'
import { Client } from 'langsmith'

const PROJECT = process.argv[2] ?? 'llmEngine'
const DAYS = Number(process.argv[3] ?? 60)
const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

const AGENT_NAMES = [
  'chatbot',
  'voiceAssistant',
  'eventSetup',
  'backChannelMetrics',
  'backChannelInsights',
  'scorekeeper',
  'conceptCartographer'
]

async function main() {
  const startTime = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()
  console.log(`Project: ${PROJECT}, window: ${DAYS}d since ${startTime}`)
  console.log('')
  console.log('=== Per agent-type (root/chain runs, name = agentType) ===')
  const rows: { name: string; count: number; prompt: number; completion: number; cost: number }[] = []
  for (const name of AGENT_NAMES) {
    console.log(`  querying ${name}...`)
    const stats = await client.getRunStats({
      projectNames: [PROJECT],
      isRoot: true,
      startTime,
      filter: `eq(name, "${name}")`
    })
    const s = stats as Record<string, number>
    rows.push({
      name,
      count: s.run_count ?? 0,
      prompt: s.prompt_tokens ?? 0,
      completion: s.completion_tokens ?? 0,
      cost: s.total_cost ?? 0
    })
  }
  rows.sort((a, b) => b.cost - a.cost)
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)
  for (const r of rows) {
    console.log(
      `${r.name}: ${
        r.count
      } turns, ${r.prompt.toLocaleString()} prompt tok, ${r.completion.toLocaleString()} completion tok, ` +
        `$${r.cost.toFixed(2)} (${((r.cost / totalCost) * 100).toFixed(1)}%), avg prompt/turn=${Math.round(
          r.prompt / Math.max(r.count, 1)
        ).toLocaleString()}`
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
