import { Client } from 'langsmith'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import {
  AgentCostBreakdown,
  ConversationCostAggregates,
  ConversationCostPhases,
  ModelCostBreakdown
} from '../../types/index.types.js'

/* Runs land in LangSmith asynchronously, and agents dispatched by the same
   conversationStopped event (e.g. the Vibes Analyst recap) are still making LLM
   calls while this fetch runs. So the settle wrapper polls until two consecutive
   reads see the same non-zero LLM-call count. The delay budget totals ~7 minutes,
   deliberately under agenda's default 10-minute job lock so a slow settle can
   never cause the job to be re-dispatched mid-poll. */
const SETTLE_DELAYS_MS = [60_000, 90_000, 120_000, 150_000]

type CostPhase = 'liveEvent' | 'postEvent'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* Matches the tag the traceable wrappers (agent respond/onConversationEvent, the
   lifecycle stop-time summary) write on every trace root. */
function conversationFilter(conversationId: string): string {
  return `and(eq(metadata_key, "conversationId"), eq(metadata_value, "${conversationId}"))`
}

/* Token and cost fields are not all present in the SDK's Run type (they arrive as
   snake_case JSON), so read them defensively rather than trusting the typings. */
function numberField(run: Record<string, unknown>, field: string): number {
  const value = Number(run[field])
  return Number.isFinite(value) ? value : 0
}

/* total_cost is null (not 0) when LangSmith has no pricing-table entry for a run's
   model — verified empirically 2026-07-14 against self-hosted vLLM/Ollama models,
   which report real token counts but no price to look up. numberField() above
   coerces both null and a genuine $0 to 0, which would silently hide that
   distinction, so this checks the raw value before that coercion happens.

   Future idea, not built: a custom cost-estimation adapter for self-hosted
   platforms (e.g. a configurable $/1K-token rate) could fill in an estimate here
   instead of leaving it unpriced. Deferred because none of the app's
   production-configured models (see supportedModels in getModelChat.ts) currently
   run on an unpriced platform — Bedrock, OpenAI, and Google are all priced. */
function isPriced(run: Record<string, unknown>, field: string): boolean {
  return run[field] !== null && run[field] !== undefined
}

/* Mutable accumulator for one phase, built up run-by-run and finalized into a plain
   ConversationCostAggregates (with sorted arrays) once every llm run has been seen. */
class PhaseAccumulator {
  estimatedCostUSD = 0

  totalPromptTokens = 0

  totalCompletionTokens = 0

  llmCallCount = 0

  models = new Map<string, ModelCostBreakdown>()

  agents = new Map<string, AgentCostBreakdown>()

  hasUnpricedCalls = false

  add(run: Record<string, unknown>, agentType: string): void {
    const promptTokens = numberField(run, 'prompt_tokens')
    const completionTokens = numberField(run, 'completion_tokens')
    const cost = numberField(run, 'total_cost')
    const priced = isPriced(run, 'total_cost')
    this.llmCallCount += 1
    this.totalPromptTokens += promptTokens
    this.totalCompletionTokens += completionTokens
    this.estimatedCostUSD += cost
    if (!priced) this.hasUnpricedCalls = true

    const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata
    const model = String(metadata?.ls_model_name ?? run.name)
    const modelRow = this.models.get(model) ?? {
      model,
      llmCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUSD: 0,
      priced: true
    }
    modelRow.llmCalls += 1
    modelRow.promptTokens += promptTokens
    modelRow.completionTokens += completionTokens
    modelRow.estimatedCostUSD += cost
    modelRow.priced = modelRow.priced && priced
    this.models.set(model, modelRow)

    const agentRow = this.agents.get(agentType) ?? { agentType, llmCalls: 0, estimatedCostUSD: 0 }
    agentRow.llmCalls += 1
    agentRow.estimatedCostUSD += cost
    this.agents.set(agentType, agentRow)
  }

  finalize(): ConversationCostAggregates {
    return {
      estimatedCostUSD: this.estimatedCostUSD,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      llmCallCount: this.llmCallCount,
      models: [...this.models.values()].sort((a, b) => b.estimatedCostUSD - a.estimatedCostUSD),
      agents: [...this.agents.values()].sort((a, b) => b.estimatedCostUSD - a.estimatedCostUSD),
      hasUnpricedCalls: this.hasUnpricedCalls
    }
  }
}

/**
 * Fetches one conversation's LLM cost estimate from LangSmith, split by costPhase.
 * Two passes: trace roots tagged with the conversationId (whose names are the
 * agentType and whose metadata carries costPhase), then the llm-type runs inside
 * those traces, which carry the per-call token counts and LangSmith's cost
 * estimates. Totals are summed from llm-type LEAF runs only — never root rollups —
 * so nothing is double counted. A leaf run whose trace root is missing costPhase
 * (should not happen once Task 1 has shipped everywhere) defaults to liveEvent.
 *
 * Returns null when LangSmith is not configured, no tagged roots exist (yet), or
 * the query fails; callers treat null as "not ready, maybe retry".
 */
export async function fetchConversationCost(conversationId: string): Promise<ConversationCostPhases | null> {
  if (!config.langsmith.key || !config.langsmith.project) {
    logger.debug('numberCruncher: LangSmith key or project not configured; skipping cost fetch')
    return null
  }
  const client = new Client({ apiKey: config.langsmith.key })

  try {
    const traceInfo = new Map<string, { agentType: string; costPhase: CostPhase }>()
    for await (const run of client.listRuns({
      projectName: config.langsmith.project,
      isRoot: true,
      filter: conversationFilter(conversationId)
    })) {
      const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata
      const costPhase: CostPhase = metadata?.costPhase === 'postEvent' ? 'postEvent' : 'liveEvent'
      traceInfo.set(String(run.trace_id ?? run.id), { agentType: run.name, costPhase })
    }
    if (traceInfo.size === 0) return null

    const accumulators: Record<CostPhase, PhaseAccumulator> = {
      liveEvent: new PhaseAccumulator(),
      postEvent: new PhaseAccumulator()
    }

    /* traceFilter applies the metadata filter to each run's trace root, so this
       returns the children of exactly the roots found above without a per-trace
       query loop. */
    for await (const run of client.listRuns({
      projectName: config.langsmith.project,
      runType: 'llm',
      traceFilter: conversationFilter(conversationId)
    })) {
      const raw = run as unknown as Record<string, unknown>
      const info = traceInfo.get(String(run.trace_id))
      accumulators[info?.costPhase ?? 'liveEvent'].add(raw, info?.agentType ?? 'unknown')
    }

    return { liveEvent: accumulators.liveEvent.finalize(), postEvent: accumulators.postEvent.finalize() }
  } catch (error) {
    logger.error(`numberCruncher: LangSmith cost fetch failed for ${conversationId}`, error)
    return null
  }
}

/**
 * Merges two phase aggregates into one, summing shared models/agents by key rather
 * than concatenating duplicates. Used to build a combined headline total from the
 * two separately-stored phases — the phases themselves are never merged before
 * persistence, only when a caller explicitly wants one number.
 */
export function combineCostAggregates(
  a: ConversationCostAggregates,
  b: ConversationCostAggregates
): ConversationCostAggregates {
  const models = new Map<string, ModelCostBreakdown>()
  for (const row of [...a.models, ...b.models]) {
    const existing = models.get(row.model)
    models.set(
      row.model,
      existing
        ? {
            model: row.model,
            llmCalls: existing.llmCalls + row.llmCalls,
            promptTokens: existing.promptTokens + row.promptTokens,
            completionTokens: existing.completionTokens + row.completionTokens,
            estimatedCostUSD: existing.estimatedCostUSD + row.estimatedCostUSD,
            priced: existing.priced && row.priced
          }
        : { ...row }
    )
  }

  const agents = new Map<string, AgentCostBreakdown>()
  for (const row of [...a.agents, ...b.agents]) {
    const existing = agents.get(row.agentType)
    agents.set(
      row.agentType,
      existing
        ? {
            agentType: row.agentType,
            llmCalls: existing.llmCalls + row.llmCalls,
            estimatedCostUSD: existing.estimatedCostUSD + row.estimatedCostUSD
          }
        : { ...row }
    )
  }

  return {
    estimatedCostUSD: a.estimatedCostUSD + b.estimatedCostUSD,
    totalPromptTokens: a.totalPromptTokens + b.totalPromptTokens,
    totalCompletionTokens: a.totalCompletionTokens + b.totalCompletionTokens,
    llmCallCount: a.llmCallCount + b.llmCallCount,
    models: [...models.values()].sort((x, y) => y.estimatedCostUSD - x.estimatedCostUSD),
    agents: [...agents.values()].sort((x, y) => y.estimatedCostUSD - x.estimatedCostUSD),
    hasUnpricedCalls: a.hasUnpricedCalls || b.hasUnpricedCalls
  }
}

/**
 * Fetches until the COMBINED (both phases summed) LLM-call count is non-zero and
 * unchanged across two consecutive reads, or the delay budget runs out. Returns the
 * last read, which may be null (no data ever appeared) or all-zero (nothing tagged).
 */
export async function fetchConversationCostWithSettle(
  conversationId: string,
  delaysMs: number[] = SETTLE_DELAYS_MS
): Promise<ConversationCostPhases | null> {
  const combinedCount = (phases: ConversationCostPhases | null) =>
    phases ? phases.liveEvent.llmCallCount + phases.postEvent.llmCallCount : 0

  let previous: ConversationCostPhases | null = null
  let current = await fetchConversationCost(conversationId)
  let attempt = 1
  logger.debug(
    `numberCruncher: settle-poll attempt ${attempt} for ${conversationId} — combined calls: ${combinedCount(current)}`
  )

  for (const delayMs of delaysMs) {
    if (combinedCount(current) > 0 && combinedCount(current) === combinedCount(previous)) {
      logger.info(`numberCruncher: settle-poll settled for ${conversationId} after ${attempt} attempt(s)`)
      return current
    }
    previous = current
    await sleep(delayMs)
    attempt += 1
    current = await fetchConversationCost(conversationId)
    logger.debug(
      `numberCruncher: settle-poll attempt ${attempt} for ${conversationId} — combined calls: ${combinedCount(current)}`
    )
  }

  if (combinedCount(current) > 0 && combinedCount(current) === combinedCount(previous)) {
    logger.info(`numberCruncher: settle-poll settled for ${conversationId} after ${attempt} attempt(s)`)
  } else {
    logger.info(`numberCruncher: settle-poll exhausted its delay budget for ${conversationId} after ${attempt} attempt(s)`)
  }
  return current
}
