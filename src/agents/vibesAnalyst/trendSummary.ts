import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { CuratedVibesData, CuratedVibesStandout, CuratedVibesVisual, TrendSnapshotView } from '../../types/index.types.js'
import eventDateLabel from '../../utils/eventDateLabel.js'
import { VIBES_TREND_SYSTEM_PROMPT, VIBES_TREND_USER_TEMPLATE } from './prompt.js'

/* Slack's data_visualization block caps every category and data point label at 20 characters,
   so the trend labels each event by its short UTC date (e.g. "Jun 3"), the part that actually
   distinguishes events in a series, rather than the full "Name (date)", which runs past 20 and
   is what got the block rejected before. Two events on the same day are disambiguated so the
   categories stay unique, which the block also requires. Event names live in the prose standouts. */
const MAX_LABEL_LENGTH = 20

function buildTrendLabels(snapshots: TrendSnapshotView[]): string[] {
  const seen = new Map<string, number>()
  return snapshots.map((snapshot, index) => {
    const base = eventDateLabel(null, snapshot.endTime, `Event ${index + 1}`).slice(0, MAX_LABEL_LENGTH)
    const priorCount = seen.get(base) ?? 0
    seen.set(base, priorCount + 1)
    if (priorCount === 0) return base
    // Same-day collision: append a counter, trimming the base so the whole label still fits.
    const suffix = ` (${priorCount + 1})`
    return `${base.slice(0, MAX_LABEL_LENGTH - suffix.length)}${suffix}`
  })
}

/* Builds the one chart a trend card carries: poster count per event, in the given order.
   Poster count is exact and present for every event, so it is the cleanest cross-event
   engagement signal and never needs null handling. The estimate metrics (lurkers, rate,
   dwell) can be null per event, so they are left to the prose, which can caveat them.

   Drawn as a line, which reads as a trend over time. line is a valid data_visualization chart
   type; the block was never rejected for its type, only for labels over the 20-character limit
   (see buildTrendLabels). */
export function buildTrendChart(snapshots: TrendSnapshotView[]): CuratedVibesVisual {
  const labels = buildTrendLabels(snapshots)
  const data = snapshots.map((snapshot, index) => ({ label: labels[index], value: snapshot.posterCount }))
  return {
    title: 'Posters per event',
    chart: {
      type: 'line',
      series: [{ name: 'Posters', data }],
      axisConfig: { categories: labels, yLabel: 'Posters' }
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
  'name',
  'endTime'
])

/* A trailing sequence marker on an event's name ("Vibes #3", "AI Ethics Session 2", "Standup Part 3")
   tells the reader nothing about when the event ran, and a series can be renumbered or rescheduled so
   that marker points the opposite way from real chronology. Handed such a name, a small model narrates
   the trend in name-number order rather than time order, no matter how the surrounding order is stated.
   So the marker is dropped from the label the trend writer sees, leaving the series' base name (which
   the header still wants) and the row's own "order" field to carry the timeline. Only a trailing "#N"
   or a "<sequence-word> N" tail is removed; a distinct title ("Web3 Meetup", "Catch-22") keeps its
   number, since a trend that compares different events by name still needs those names whole. */
const SERIES_ORDINAL_TAIL =
  /[\s:–-]*(?:#\s*\d+|(?:session|part|vol\.?|volume|episode|ep\.?|day|week|chapter|no\.?|pt\.?)\s+(?:\d+|[ivxlcdm]+))\s*$/i

function stripSeriesOrdinal(name: string | null | undefined): string | null | undefined {
  if (!name) return name
  const stripped = name.replace(SERIES_ORDINAL_TAIL, '').trim()
  // Guard against a name that is only an ordinal ("#3"): keep the original rather than blank it.
  return stripped || name
}

/* The per-event row handed to the writer: a 1-based chronological position, a readable event label,
   plus every metric the snapshot carries, with the identifying and versioning fields stripped. There
   is no allowlist of metrics, so anything we store reaches the comparison. Reads a Mongoose document
   (via toObject) or a plain object alike.

   `order` is the authoritative timeline. Callers pass snapshots already sorted oldest-first, so the
   array index is the true position, 1 for the earliest. A number in the event's own name (a series
   "#3", a "Session 2") can disagree with real chronology after a reschedule or renumber, and a small
   model will otherwise narrate the trend in name order rather than time order. The explicit `order`
   field, which the trend prompt is told to trust over any name, keeps the read pointed at real time. */
export function trendRow(snapshot: TrendSnapshotView, index?: number): Record<string, unknown> {
  const source = snapshot as unknown as { toObject?: () => Record<string, unknown> } & Record<string, unknown>
  const plain = typeof source.toObject === 'function' ? source.toObject() : { ...source }
  const row: Record<string, unknown> = {
    ...(typeof index === 'number' && { order: index + 1 }),
    event: eventDateLabel(
      stripSeriesOrdinal(plain.name as string | null | undefined),
      plain.endTime as Date | undefined,
      'Event'
    )
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
 * Builds a comparative engagement card across several events from their stored snapshots.
 * Sorted here by endTime, oldest first, so the trend reads left to right: the caller's order is
 * not trusted (stored snapshots are fetched newest-first and a live recompute is expected to
 * preserve that, but two events landing on the same day, or any other tie in the upstream sort,
 * can leave the array in an order that does not actually match true chronology, and a chart that
 * merely reversed whatever it was given would silently plot the wrong direction). Sorting by the
 * snapshot's own endTime makes the order correct regardless of how the caller assembled the
 * array. A deterministic poster-per-event chart is built here and attached to the first standout,
 * and the model writes the header and 1 to 3 comparative lines over the scalar metrics only. No
 * live recompute and no LLM content pass run, so nothing here reads message text. durationMinutes
 * is left unset because a trend spans many events, so the card renders no single-event duration
 * footer.
 */
export default async function buildTrendSummary(snapshots: TrendSnapshotView[], llm): Promise<CuratedVibesData> {
  const ordered = [...snapshots].sort((a, b) => a.endTime.getTime() - b.endTime.getTime())
  const chart = buildTrendChart(ordered)

  const curation = (await getChatPromptResponse(
    llm,
    VIBES_TREND_SYSTEM_PROMPT,
    VIBES_TREND_USER_TEMPLATE,
    {
      eventCount: ordered.length,
      metricsJson: JSON.stringify(ordered.map((snapshot, index) => trendRow(snapshot, index)))
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
    standouts
  }
}
