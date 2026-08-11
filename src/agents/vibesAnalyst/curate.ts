import { z } from 'zod'
import { getChatPromptResponse } from '../helpers/llmChain.js'
import { VIBES_CURATION_SYSTEM_PROMPT, VIBES_CURATION_USER_TEMPLATE } from './prompt.js'
import { ConversationMetrics, CuratedVibesChart, CuratedVibesData, CuratedVibesStandout } from '../../types/index.types.js'

/* What the model returns: a header, optional framing, an overall mood, and 2 to 3
   short insights. Each insight can name one chart to show (by key) and a caption
   for it. The model only ever references chart keys we hand it; it never sends raw
   chart data, so the numbers on every chart stay first-party and trustworthy. */
const CurationSchema = z.object({
  header: z.string().describe('One-line verdict headline that includes the event name'),
  framing: z.string().optional().describe('Optional one-line gist shown under the header'),
  // nullish, not required: the prompt still asks for a state, but nothing downstream reads it, so a
  // dropped or null value should never fail the whole card (small models omit it often enough to matter).
  state: z.enum(['negative', 'positive', 'quiet']).nullish(),
  standouts: z
    .array(
      z.object({
        text: z.string().describe('Slack mrkdwn insight naming the specific numbers, with caveats inline'),
        // nullish, not optional: the model routinely emits an explicit null for "no chart" rather
        // than omitting the key, and Zod's .optional() rejects null. Both are treated as "no chart".
        chartKey: z.string().nullish().describe('One of the provided chart keys, or omit if no chart fits'),
        caption: z.string().nullish().describe('One-line plain-language description of the attached chart')
      })
    )
    .min(2)
    .max(3)
})

/* A chart we have already built from real numbers, offered to the model to attach.
   `description` tells the model what the chart shows so it can decide whether to
   use it; `title` and `chart` are what actually get rendered. */
interface ChartCandidate {
  description: string
  title: string
  chart: CuratedVibesChart
}

/* Builds the set of charts the model is allowed to attach, each from real computed
   numbers. A chart only appears when its data exists, so the model can never pick a
   chart we cannot back with data. Keys are stable so the model can reference them. */
export function buildChartCandidates(metrics: ConversationMetrics): Record<string, ChartCandidate> {
  const candidates: Record<string, ChartCandidate> = {}

  if (metrics.activitySeries.length > 0) {
    candidates.activity = {
      description: 'Messages over time, showing when the room was busy or quiet',
      title: 'Messages over time',
      chart: {
        type: 'bar',
        series: [{ name: 'Messages', data: metrics.activitySeries.map((b) => ({ label: b.label, value: b.messageCount })) }],
        axisConfig: { categories: metrics.activitySeries.map((b) => b.label), yLabel: 'Messages' }
      }
    }
  }

  // Posters vs lurkers for this event. Only when the counts reconcile, since lurkers
  // (people who joined without posting) can only be derived from a participant count
  // that is at least the poster count. When posters exceed participants, lurkerCount
  // is null and there is no honest split to draw, so we skip the chart.
  if (metrics.audienceEngagement.lurkerCount !== null) {
    candidates.audienceSplit = {
      description: 'How many people posted versus lurked (joined without posting)',
      title: 'Posters vs lurkers',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Posted', value: metrics.participation.posterCount },
          { label: 'Lurked', value: metrics.audienceEngagement.lurkerCount }
        ]
      }
    }
  }

  // Needs at least one past event alongside "Today" to read as a trend. Posters are
  // always exact; a lurkers series is added only when every point has a known lurker
  // count, so the chart never implies zero lurkers where the number is simply unknown.
  if (metrics.participationHistory.length >= 2) {
    const labels = metrics.participationHistory.map((p) => p.label)
    const series = [
      { name: 'Posters', data: metrics.participationHistory.map((p) => ({ label: p.label, value: p.posterCount })) }
    ]
    const everyPointKnown = metrics.participationHistory.every((p) => p.lurkerCount !== null)
    if (everyPointKnown) {
      series.push({
        name: 'Lurkers',
        data: metrics.participationHistory.map((p) => ({ label: p.label, value: p.lurkerCount as number }))
      })
    }
    candidates.engagementHistory = {
      description: everyPointKnown
        ? 'Posters and lurkers across recent events in this topic, ending with today'
        : 'Posters across recent events in this topic, ending with today',
      title: 'Engagement over recent events',
      chart: {
        type: 'bar',
        series,
        axisConfig: { categories: labels, yLabel: 'People' }
      }
    }
  }

  if (metrics.baseline) {
    candidates.postersVsBaseline = {
      description: "This event's poster count next to the topic's recent average",
      title: 'This event vs recent average',
      chart: {
        type: 'bar',
        series: [
          {
            name: 'Posters',
            data: [
              { label: 'This event', value: metrics.participation.posterCount },
              { label: 'Recent avg', value: metrics.baseline.avgPosterCount }
            ]
          }
        ],
        axisConfig: { categories: ['This event', 'Recent avg'], yLabel: 'Posters' }
      }
    }
  }

  if (metrics.peerBaseline) {
    candidates.postersVsPeers = {
      description: "This event's poster count next to the average for public events of about the same size and platform",
      title: 'This event vs similar-sized events',
      chart: {
        type: 'bar',
        series: [
          {
            name: 'Posters',
            data: [
              { label: 'This event', value: metrics.participation.posterCount },
              { label: 'Similar events avg', value: metrics.peerBaseline.avgPosterCount }
            ]
          }
        ],
        axisConfig: { categories: ['This event', 'Similar events avg'], yLabel: 'Posters' }
      }
    }
  }

  const total = metrics.channelSplit.public + metrics.channelSplit.private
  if (total > 0) {
    candidates.channelSplit = {
      description: 'How messages split between public chat and private one-to-one with the bot',
      title: 'Where messages went',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Public chat', value: metrics.channelSplit.public },
          { label: 'Private (bot)', value: metrics.channelSplit.private }
        ]
      }
    }
  }

  // An empty room has no one-time/repeat split to draw: both counts sum to posterCount.
  if (metrics.participation.posterCount > 0) {
    candidates.posterMix = {
      description: 'How many people posted just once versus came back to post more than once',
      title: 'Repeat vs one-time posters',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Posted once', value: metrics.participationConcentration.oneTimePosterCount },
          { label: 'Posted more than once', value: metrics.participationConcentration.repeatPosterCount }
        ]
      }
    }
  }

  const [firstSource] = metrics.trackedSessionSources
  if (firstSource && Object.keys(firstSource.deviceBreakdown).length > 0) {
    candidates.devices = {
      description: 'Device mix of tracked sessions (can undercount)',
      title: 'Devices (tracked sessions)',
      chart: {
        type: 'pie',
        segments: Object.entries(firstSource.deviceBreakdown).map(([label, value]) => ({ label, value }))
      }
    }
  }

  if (firstSource && Object.keys(firstSource.actionBreakdown).length > 0) {
    candidates.featureUsage = {
      description:
        'How many times tracked visitors used each on-page feature (commands, tabs, transcript); counts only, can undercount',
      title: 'Feature usage (tracked sessions)',
      chart: {
        type: 'bar',
        series: [
          {
            name: 'Actions',
            data: Object.entries(firstSource.actionBreakdown).map(([label, value]) => ({ label, value }))
          }
        ],
        axisConfig: { categories: Object.keys(firstSource.actionBreakdown), yLabel: 'Actions' }
      }
    }
  }

  return candidates
}

/* The fixed wording for when tracked-session data is missing, so the card states
   the limitation consistently rather than leaving the model to phrase it. Returns
   undefined when the data is present and no caveat is needed. */
function availabilityNoteFor(status: ConversationMetrics['trackedSessionStatus']): string | undefined {
  if (status === 'notTracked') {
    return 'No tracked-session data this time, so this is built only on the messages people sent, which is exact.'
  }
  if (status === 'unavailable') {
    return "Tracked-session data couldn't be retrieved this time, so this is built only on the messages people sent."
  }
  return undefined
}

/* Strips each candidate down to what the model needs to choose (description plus
   the underlying data), so it can write accurate prose without us shipping the full
   render shape into the prompt. */
function candidateCatalogForPrompt(candidates: Record<string, ChartCandidate>) {
  return Object.fromEntries(
    Object.entries(candidates).map(([key, candidate]) => [
      key,
      { description: candidate.description, chart: candidate.chart }
    ])
  )
}

/**
 * Asks the model to read one event's metrics and write the recap card: a verdict
 * header, optional framing, and the 2 to 3 most notable insights across all the
 * data. The model picks which pre-built chart (if any) illustrates each insight by
 * key, so chart numbers always come from our computed metrics, never the model.
 * The data-availability note is set from trackedSessionStatus here, not by the
 * model, so the limitation is always stated consistently.
 */
export default async function curateVibesCard(
  metrics: ConversationMetrics,
  eventMeta: { eventName: string; durationMinutes: number; speakerCount?: number; activeAgentTypeLabels?: string[] },
  llm
): Promise<CuratedVibesData> {
  const candidates = buildChartCandidates(metrics)

  const curation = (await getChatPromptResponse(
    llm,
    VIBES_CURATION_SYSTEM_PROMPT,
    VIBES_CURATION_USER_TEMPLATE,
    {
      eventName: eventMeta.eventName,
      durationMinutes: eventMeta.durationMinutes,
      speakerCount: eventMeta.speakerCount ?? 0,
      activeAgentTypeLabels: (eventMeta.activeAgentTypeLabels ?? []).join(', ') || 'none',
      trackedSessionStatus: metrics.trackedSessionStatus,
      metricsJson: JSON.stringify(metrics),
      candidatesJson: JSON.stringify(candidateCatalogForPrompt(candidates))
    },
    undefined,
    CurationSchema
  )) as z.infer<typeof CurationSchema>

  const standouts: CuratedVibesStandout[] = curation.standouts.slice(0, 3).map((standout) => {
    const candidate = standout.chartKey ? candidates[standout.chartKey] : undefined
    if (!candidate) return { text: standout.text }
    return {
      text: standout.text,
      visual: {
        title: candidate.title,
        chart: candidate.chart,
        ...(standout.caption && { caption: standout.caption })
      }
    }
  })

  const availabilityNote = availabilityNoteFor(metrics.trackedSessionStatus)

  return {
    header: curation.header,
    ...(curation.framing && { framing: curation.framing }),
    ...(availabilityNote && { availabilityNote }),
    standouts,
    durationMinutes: eventMeta.durationMinutes
  }
}
