import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { CuratedVibesData, CuratedVibesStandout, CuratedVibesVisual } from '../../types/index.types.js'
import { VIBES_TREND_SYSTEM_PROMPT, VIBES_TREND_USER_TEMPLATE } from './prompt.js'

/* The slice of a stored snapshot a trend reads. A snapshot document carries more, but the
   comparison only needs these scalar counts; quote text is never stored, so a trend is
   quote-free by construction. */
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* A short label for one event on the trend axis: its name plus a UTC date, so events in a
   recurring series (which share a name) stay distinguishable. Falls back to the date alone, or
   a placeholder, when a name or date is missing. The date is the UTC calendar day, so it is
   deterministic but can read a day off for a viewer in a far timezone, the same tradeoff the
   single-event history labels make. */
function trendLabel(name: string | null | undefined, endTime: Date | undefined): string {
  const date = endTime ? `${MONTHS[endTime.getUTCMonth()]} ${endTime.getUTCDate()}` : ''
  const trimmedName = name?.trim()
  if (trimmedName && date) return `${trimmedName} (${date})`
  return trimmedName || date || 'Event'
}

/* Builds the one chart a trend card carries: poster count per event, in the given order.
   Poster count is exact and present for every event, so it is the cleanest cross-event
   engagement signal and never needs null handling. The estimate metrics (lurkers, rate,
   dwell) can be null per event, so they are left to the prose, which can caveat them. */
export function buildTrendChart(snapshots: TrendSnapshotView[]): CuratedVibesVisual {
  const data = snapshots.map((snapshot) => ({
    label: trendLabel(snapshot.eventName, snapshot.eventEndTime),
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

/* The compact per-event row handed to the writer: the label plus the scalar counts, with the
   internal ids and document machinery dropped. */
function trendRow(snapshot: TrendSnapshotView) {
  return {
    event: trendLabel(snapshot.eventName, snapshot.eventEndTime),
    posterCount: snapshot.posterCount,
    messageCount: snapshot.messageCount,
    lurkerCount: snapshot.lurkerCount,
    participationRate: snapshot.participationRate,
    avgDwellSeconds: snapshot.avgDwellSeconds,
    spikeCount: snapshot.spikeCount,
    channelSplit: snapshot.channelSplit ?? { public: 0, private: 0 }
  }
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
