/* eslint-disable no-console */
import 'dotenv/config'
import { Client } from 'langsmith'

const PROJECT = process.argv[2] ?? 'llmEngine'
const DAYS = Number(process.argv[3] ?? 60)
const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

async function main() {
  const startTime = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()
  const rootStats = await client.getRunStats({ projectNames: [PROJECT], isRoot: true, startTime })
  console.log('=== root run stats ===')
  console.log(JSON.stringify(rootStats, null, 2))

  const llmStats = await client.getRunStats({ projectNames: [PROJECT], runType: 'llm', startTime })
  console.log('=== llm run stats ===')
  console.log(JSON.stringify(llmStats, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
