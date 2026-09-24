/* eslint-disable no-console */
import 'dotenv/config'
import { Client } from 'langsmith'

const PROJECT = process.argv[2] ?? 'llmEngine'
const START_DAYS_AGO = Number(process.argv[3] ?? 35)
const END_DAYS_AGO = Number(process.argv[4] ?? 28)
const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

async function main() {
  const startTime = new Date(Date.now() - START_DAYS_AGO * 24 * 60 * 60 * 1000)
  const endTime = new Date(Date.now() - END_DAYS_AGO * 24 * 60 * 60 * 1000)
  console.log(`Project: ${PROJECT}, window: ${startTime.toISOString()} .. ${endTime.toISOString()}`)
  // listRuns has no endTime param — it only bounds the lower edge, so results (returned
  // newest-first) are filtered/truncated client-side against the upper edge instead.
  const counts = new Map<string, { n: number; prompt: number }>()
  let n = 0
  for await (const run of client.listRuns({
    projectName: PROJECT,
    isRoot: true,
    startTime,
    select: ['name']
  })) {
    const runStart = new Date(run.start_time as unknown as string)
    if (runStart > endTime) continue
    n++
    const row = counts.get(run.name) ?? { n: 0, prompt: 0 }
    row.n++
    counts.set(run.name, row)
    if (n % 1000 === 0) console.log(`  ...${n} scanned`)
  }
  console.log(`Total root runs in window: ${n}`)
  for (const [name, c] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${name}: ${c.n} (${((c.n / n) * 100).toFixed(1)}%)`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
