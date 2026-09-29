/* eslint-disable no-console */
import 'dotenv/config'
import { Client } from 'langsmith'

const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

async function main() {
  let n = 0
  for await (const p of client.listProjects()) {
    n++
    console.log(p.name, p.id, (p as unknown as Record<string, unknown>).run_count ?? '')
  }
  console.log('total projects visible:', n)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
