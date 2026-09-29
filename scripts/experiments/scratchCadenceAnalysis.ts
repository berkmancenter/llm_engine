/* eslint-disable no-console */
/* Read-only LangSmith analysis: for moderatorNotifier and proactiveGroupAgent, group real
   calls by conversationId and compare actual call count to the naive "fired every single
   120s tick for the conversation's whole active span" expectation. This tells us how much
   the existing framework-level gates (evaluate()'s lastActiveMessageCount check for
   moderatorNotifier; the minInterval cooldown for proactiveGroupAgent) already suppress in
   practice, so a further-gating estimate isn't double-counting savings that already exist. */
import 'dotenv/config'
import { Client } from 'langsmith'

const PROJECT = process.argv[2] ?? 'llmEngine'
const DAYS = Number(process.argv[3] ?? 60)
const TIMER_PERIOD_S = 120
const client = new Client({ apiKey: process.env.LANGSMITH_API_KEY })

async function main() {
  const startTime = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
  for (const agentName of ['moderatorNotifier', 'proactiveGroupAgent']) {
    console.log(`\n=== ${agentName} ===`)
    const byConversation = new Map<string, number[]>()
    let n = 0
    for await (const run of client.listRuns({
      projectName: PROJECT,
      isRoot: true,
      startTime,
      filter: `eq(name, "${agentName}")`,
      select: ['start_time', 'extra']
    })) {
      n++
      const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata
      const conversationId = metadata?.conversationId as string | undefined
      if (!conversationId) continue
      const arr = byConversation.get(conversationId) ?? []
      arr.push(new Date(run.start_time as unknown as string).getTime())
      byConversation.set(conversationId, arr)
    }
    console.log(`total root runs scanned: ${n}, distinct conversations: ${byConversation.size}`)

    let totalActual = 0
    let totalExpected = 0
    const rows: { conversationId: string; actual: number; expectedIfEveryTick: number; spanMin: number }[] = []
    for (const [conversationId, times] of byConversation.entries()) {
      times.sort((a, b) => a - b)
      const spanMs = times[times.length - 1] - times[0]
      const expectedIfEveryTick = Math.floor(spanMs / (TIMER_PERIOD_S * 1000)) + 1
      totalActual += times.length
      totalExpected += expectedIfEveryTick
      rows.push({ conversationId, actual: times.length, expectedIfEveryTick, spanMin: Math.round(spanMs / 60000) })
    }
    rows.sort((a, b) => b.actual - a.actual)
    console.log('top 10 conversations by call count:')
    for (const r of rows.slice(0, 10)) {
      console.log(
        `  ${r.conversationId}: actual=${r.actual}, expectedIfEveryTick=${r.expectedIfEveryTick}, ` +
          `span=${r.spanMin}min, actual/expected=${(r.actual / Math.max(r.expectedIfEveryTick, 1)).toFixed(2)}`
      )
    }
    console.log(
      `TOTALS: actual calls=${totalActual}, expected-if-every-tick=${totalExpected}, ` +
        `already-firing-rate=${((totalActual / Math.max(totalExpected, 1)) * 100).toFixed(1)}%`
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
