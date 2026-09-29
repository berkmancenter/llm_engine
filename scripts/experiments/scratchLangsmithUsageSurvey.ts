/* eslint-disable no-console */
/* Scratch, throwaway survey script — not part of the app. Queries LangSmith directly
   (same Client/pattern as src/agents/numberCruncher/conversationCost.ts) to characterize
   real token usage over the last N days, broken out by agent type and model, and to look
   for a relationship between conversation size (participant/channel fan-out, history
   length) and prompt-token growth. Read-only against LangSmith; touches no app DB. */
import 'dotenv/config'
import { Client } from 'langsmith'

const DAYS = Number(process.argv[2] ?? 60)
const PROJECT = process.argv[3] ?? process.env.LANGSMITH_PROJECT
const API_KEY = process.env.LANGSMITH_API_KEY

if (!PROJECT || !API_KEY) {
  console.error('LANGSMITH_PROJECT / LANGSMITH_API_KEY not set')
  process.exit(1)
}

const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)
const client = new Client({ apiKey: API_KEY })

console.log(`Project: ${PROJECT}`)
console.log(`Window: since ${since.toISOString()} (${DAYS}d)`)

type RootInfo = {
  agentType: string
  costPhase: string
  llmModel?: string
  llmPlatform?: string
  channelsCount?: number
  historyLen?: number
  conversationId?: string
  startTime?: string
}

async function main() {
  const roots = new Map<string, RootInfo>()
  let rootCount = 0
  for await (const run of client.listRuns({
    projectName: PROJECT!,
    isRoot: true,
    startTime: since
  })) {
    rootCount++
    const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}
    const channels = metadata.channels as unknown[] | undefined
    const history = metadata.conversationHistory as { messages?: unknown[] } | unknown[] | undefined
    let historyLen: number | undefined
    if (Array.isArray(history)) {
      historyLen = history.length
    } else if (Array.isArray((history as { messages?: unknown[] })?.messages)) {
      historyLen = (history as { messages: unknown[] }).messages.length
    }
    roots.set(String(run.id), {
      agentType: run.name,
      costPhase: String(metadata.costPhase ?? 'liveEvent'),
      llmModel: metadata.llmModel as string | undefined,
      llmPlatform: metadata.llmPlatform as string | undefined,
      channelsCount: Array.isArray(channels) ? channels.length : undefined,
      historyLen,
      conversationId: metadata.conversationId as string | undefined,
      startTime: run.start_time as unknown as string
    })
    if (rootCount % 500 === 0) console.log(`  ...${rootCount} root runs scanned`)
  }
  console.log(`Total root runs (agent turns): ${rootCount}`)

  type Agg = {
    llmCalls: number
    promptTokens: number
    completionTokens: number
    cost: number
    byModel: Map<string, { calls: number; prompt: number; completion: number; cost: number }>
  }
  const byAgent = new Map<string, Agg>()
  let llmRunCount = 0
  let unmatchedTrace = 0

  for await (const run of client.listRuns({
    projectName: PROJECT!,
    runType: 'llm',
    startTime: since
  })) {
    llmRunCount++
    const raw = run as unknown as Record<string, unknown>
    const promptTokens = Number(raw.prompt_tokens) || 0
    const completionTokens = Number(raw.completion_tokens) || 0
    const cost = Number(raw.total_cost) || 0
    const metadata = (raw.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata
    const model = String(metadata?.ls_model_name ?? raw.name)

    const rootInfo = roots.get(String(raw.trace_id))
    const agentType = rootInfo?.agentType ?? 'unknown'
    if (!rootInfo) unmatchedTrace++

    const agg = byAgent.get(agentType) ?? {
      llmCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      byModel: new Map()
    }
    agg.llmCalls++
    agg.promptTokens += promptTokens
    agg.completionTokens += completionTokens
    agg.cost += cost
    const modelRow = agg.byModel.get(model) ?? { calls: 0, prompt: 0, completion: 0, cost: 0 }
    modelRow.calls++
    modelRow.prompt += promptTokens
    modelRow.completion += completionTokens
    modelRow.cost += cost
    agg.byModel.set(model, modelRow)
    byAgent.set(agentType, agg)

    if (llmRunCount % 1000 === 0) console.log(`  ...${llmRunCount} llm runs scanned`)
  }

  console.log(`Total llm runs: ${llmRunCount} (unmatched trace root: ${unmatchedTrace})`)
  console.log('')
  console.log('=== By agent type ===')
  const rows = [...byAgent.entries()].sort((a, b) => b[1].promptTokens - a[1].promptTokens)
  for (const [agentType, agg] of rows) {
    console.log(
      `${agentType}: ${agg.llmCalls} calls, ${agg.promptTokens.toLocaleString()} prompt tok, ` +
        `${agg.completionTokens.toLocaleString()} completion tok, $${agg.cost.toFixed(2)}, ` +
        `avg prompt/call = ${Math.round(agg.promptTokens / Math.max(agg.llmCalls, 1)).toLocaleString()}`
    )
    for (const [model, m] of [...agg.byModel.entries()].sort((a, b) => b[1].prompt - a[1].prompt)) {
      console.log(
        `    ${model}: ${m.calls} calls, avg prompt = ${Math.round(
          m.prompt / Math.max(m.calls, 1)
        ).toLocaleString()} tok, $${m.cost.toFixed(2)}`
      )
    }
  }

  console.log('')
  console.log('=== Conversation-size signal (root runs with channels/history metadata) ===')
  const withChannels = [...roots.values()].filter((r) => r.channelsCount !== undefined)
  const withHistory = [...roots.values()].filter((r) => r.historyLen !== undefined)
  console.log(`Root runs with channels metadata: ${withChannels.length}/${rootCount}`)
  console.log(`Root runs with history-length metadata: ${withHistory.length}/${rootCount}`)
  if (withChannels.length) {
    const dist = new Map<number, number>()
    for (const r of withChannels) dist.set(r.channelsCount!, (dist.get(r.channelsCount!) ?? 0) + 1)
    console.log(
      'channels count distribution:',
      [...dist.entries()].sort((a, b) => a[0] - b[0])
    )
  }
  if (withHistory.length) {
    const sorted = withHistory.map((r) => r.historyLen!).sort((a, b) => a - b)
    const pct = (p: number) => sorted[Math.floor((sorted.length - 1) * p)]
    console.log(
      `history length: min=${sorted[0]} p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} max=${sorted[sorted.length - 1]}`
    )
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
