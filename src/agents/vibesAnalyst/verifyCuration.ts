import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { buildChartCandidates } from './curate.js'
import { VIBES_CRITIC_SYSTEM_PROMPT, VIBES_CRITIC_USER_TEMPLATE } from './prompt.js'
import { ConversationMetrics, CuratedVibesChart, CuratedVibesData } from '../../types/index.types.js'

/* What the critic returns: one verdict per standout it was shown. `reasoning` comes
   first so the model works through each claim, and any ratio arithmetic, before it
   commits to a verdict; without it a small model tends to reason its way to a
   conclusion but leave the boolean at whatever it emitted first. `supported` is false
   when a claim is not backed by the metrics (wrong direction, invented number or
   trend, an off ratio, or a tracked-session figure stated without the undercount
   caveat). `issue` is a short reason, present only when unsupported. */
const CriticSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().describe('Zero-based position of the standout being judged'),
      reasoning: z
        .string()
        .describe('Check each claim against the data here, working out any ratio arithmetic, before deciding supported'),
      supported: z.boolean().describe('True only if every claim in the standout is backed by the metrics'),
      issue: z.string().optional().describe('Short reason the standout is unsupported, when it is')
    })
  )
})

/* Compares two values for structural equality so chart key order never matters:
   arrays match element by element in order, objects match on the same set of keys
   with equal values, everything else matches by ===. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/**
 * Deterministic guardrail: removes any attached chart whose data does not match a
 * chart we built from this event's metrics. We rebuild the allowed chart set from
 * the same metrics the card was curated from, then keep a standout's chart only if
 * it is identical to one of those. The prose stays either way; only an unbacked
 * chart is stripped. This catches a chart whose numbers drifted from the metrics
 * before it ever reaches a reader.
 */
export function dropUnbackedCharts(card: CuratedVibesData, metrics: ConversationMetrics): CuratedVibesData {
  const allowedCharts: CuratedVibesChart[] = Object.values(buildChartCandidates(metrics)).map((candidate) => candidate.chart)

  const standouts = card.standouts.map((standout) => {
    if (!standout.visual) return standout
    const isBacked = allowedCharts.some((allowed) => deepEqual(allowed, standout.visual!.chart))
    if (isBacked) return standout
    // Strip the unbacked chart, keeping the prose. A shallow copy minus `visual`
    // avoids binding an unused variable just to omit it.
    const withoutVisual = { ...standout }
    delete withoutVisual.visual
    return withoutVisual
  })

  return { ...card, standouts }
}

/* Asks a second model to fact-check the prose against the metrics and report which
   standouts are unsupported. The standouts are sent numbered so the critic can
   point back at each by index. Returns the per-standout verdicts. */
async function critiqueStandouts(
  card: CuratedVibesData,
  metrics: ConversationMetrics,
  llm
): Promise<z.infer<typeof CriticSchema>['verdicts']> {
  const numberedStandouts = card.standouts.map((standout, index) => ({ index, text: standout.text }))

  const result = (await getChatPromptResponse(
    llm,
    VIBES_CRITIC_SYSTEM_PROMPT,
    VIBES_CRITIC_USER_TEMPLATE,
    {
      metricsJson: JSON.stringify(metrics),
      standoutsJson: JSON.stringify(numberedStandouts)
    },
    undefined,
    CriticSchema
  )) as z.infer<typeof CriticSchema>

  return result.verdicts
}

/**
 * Runs both guardrail layers over a curated card and returns a card that only
 * keeps claims the data supports. First it strips any chart whose numbers do not
 * trace back to the metrics (deterministic). Then a critic model flags standouts
 * whose prose the metrics do not back, and those standouts are dropped. A flagged
 * standout is removed rather than rewritten, so nothing unsupported reaches the
 * host.
 */
export default async function verifyCuratedCard(
  card: CuratedVibesData,
  metrics: ConversationMetrics,
  llm
): Promise<CuratedVibesData> {
  const chartChecked = dropUnbackedCharts(card, metrics)

  const verdicts = await critiqueStandouts(chartChecked, metrics, llm)
  const unsupportedIndexes = new Set(verdicts.filter((verdict) => !verdict.supported).map((verdict) => verdict.index))

  const standouts = chartChecked.standouts.filter((_, index) => !unsupportedIndexes.has(index))

  return { ...chartChecked, standouts }
}
