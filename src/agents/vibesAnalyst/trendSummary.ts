import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { CuratedVibesData, CuratedVibesStandout, CuratedVibesVisual } from '../../types/index.types.js'
import eventDateLabel from '../../utils/eventDateLabel.js'
import { VIBES_TREND_SYSTEM_PROMPT, VIBES_TREND_USER_TEMPLATE } from './prompt.js'

/* The fields the trend chart and label need off a stored snapshot. trendRow reads every other
   metric generically, so a snapshot carrying more (any metric we store) reaches the writer
   without a change here; quote text is never stored, so a trend is quote-free by construction. */
export interface TrendSnapshotView {
  eventName?: string | null
  eventEndTime?: Date
  posterCount: number
  messageCount: number
  lurkerCount: number | null
  participationRate: number | null
  avgDwellSeconds: number | null
  spikeCount: number
  // Optional/nullable to accept a Mongoose snapshot document directly, where a nested object
  // is typed as possibly absent; coerced when read.
  channelSplit?: { public: number; private: number } | null
}

/* Builds the one chart a trend card carries: poster count per event, in the given order.
   Poster count is exact and present for every event, so it is the cleanest cross-event
   engagement signal and never needs null handling. The estimate metrics (lurkers, rate,
   dwell) can be null per event, so they are left to the prose, which can caveat them. */
export function buildTrendChart(snapshots: TrendSnapshotView[]): CuratedVibesVisual {
  const data = snapshots.map((snapshot) => ({
    label: eventDateLabel(snapshot.eventName, snapshot.eventEndTime, 'Event'),
    value: snapshot.posterCount
  }))
  return {
    title: 'Posters per event',
    chart: {
      type: 'line',
      series: [{ name: 'Posters', data }],
      axisConfig: { categories: data.map((point) => point.label), xLabel: 'Event', yLabel: 'Posters' }
    }
  }
}

/* Snapshot fields that identify or version a document rather than describe the event. They are
   the only fields dropped from the per-event row; everything else is a metric and passes through,
   so a newly snapshotted metric reaches the trend writer without a change here. */
const TREND_ROW_OMIT = new Set([
  '_id',
  '__v',
  'id',
  'conversationId',
  'topicId',
  'metricsVersion',
  'capturedAt',
  'createdAt',
  'updatedAt',
  'eventName',
  'eventEndTime'
])

/* The per-event row handed to the writer: a readable event label plus every metric the snapshot
   carries, with the identifying and versioning fields stripped. There is no allowlist of metrics,
   so anything we store reaches the comparison. Reads a Mongoose document (via toObject) or a plain
   object alike. */
export function trendRow(snapshot: TrendSnapshotView): Record<string, unknown> {
  const source = snapshot as unknown as { toObject?: () => Record<string, unknown> } & Record<string, unknown>
  const plain = typeof source.toObject === 'function' ? source.toObject() : { ...source }
  const row: Record<string, unknown> = {
    event: eventDateLabel(plain.eventName as string | null | undefined, plain.eventEndTime as Date | undefined, 'Event')
  }
  for (const [key, value] of Object.entries(plain)) {
    if (!TREND_ROW_OMIT.has(key)) row[key] = value
  }
  return row
}

const TrendCurationSchema = z.object({
  header: z.string().describe('One short line naming what is being compared'),
  framing: z.string().optional().describe('One optional sentence of context for the comparison'),
  standouts: z
    .array(z.object({ text: z.string().describe('One mrkdwn line naming a cross-event movement') }))
    .min(1)
    .max(3)
    .describe('1 to 3 standout lines, leading with the participation trend')
})

/**
 * Builds a comparative engagement card across several events from their stored snapshots. The
 * snapshots arrive newest-first; they are read oldest-first so the trend reads left to right.
 * A deterministic poster-per-event chart is built here and attached to the first standout, and
 * the model writes the header and 1 to 3 comparative lines over the scalar metrics only. No
 * live recompute and no LLM content pass run, so nothing here reads message text. durationMinutes
 * is 0 because a trend spans many events rather than one timed session.
 */
export default async function buildTrendSummary(snapshots: TrendSnapshotView[], llm): Promise<CuratedVibesData> {
  const ordered = [...snapshots].reverse()
  const chart = buildTrendChart(ordered)

  const curation = (await getChatPromptResponse(
    llm,
    VIBES_TREND_SYSTEM_PROMPT,
    VIBES_TREND_USER_TEMPLATE,
    {
      eventCount: ordered.length,
      metricsJson: JSON.stringify(ordered.map(trendRow))
    },
    undefined,
    TrendCurationSchema
  )) as z.infer<typeof TrendCurationSchema>

  // Attach the trend chart to the first standout; the rest are prose-only, mirroring how the
  // single-event card pairs at least one insight with its chart.
  const standouts: CuratedVibesStandout[] = curation.standouts
    .slice(0, 3)
    .map((standout, index) => (index === 0 ? { text: standout.text, visual: chart } : { text: standout.text }))

  return {
    header: curation.header,
    ...(curation.framing && { framing: curation.framing }),
    standouts,
    durationMinutes: 0
  }
}
