/* eslint-disable no-console */
import 'dotenv/config'
import { Client } from 'langsmith'

const PROJECT = process.argv[2] ?? 'llmEngine'
const HOURS = Number(process.argv[3] ?? 24)
const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

async function main() {
  const startTime = new Date(Date.now() - HOURS * 60 * 60 * 1000)
  console.log(`Project: ${PROJECT}, window: last ${HOURS}h since ${startTime.toISOString()}`)
  const counts = new Map<string, number>()
  let n = 0
  for await (const run of client.listRuns({
    projectName: PROJECT,
    isRoot: true,
    startTime,
    select: ['name']
  })) {
    n++
    counts.set(run.name, (counts.get(run.name) ?? 0) + 1)
    if (n % 500 === 0) console.log(`  ...${n} scanned`)
  }
  console.log(`Total root runs in window: ${n}`)
  for (const [name, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${c} (${((c / n) * 100).toFixed(1)}%)`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
