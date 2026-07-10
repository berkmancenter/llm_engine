import type { KnownBlock } from '@slack/types'
import { CuratedVibesChart, CuratedVibesData } from '../../../../types/index.types.js'
import { DataVisualizationBlock, normalizeDataVisualizationBlock } from './dataVisualization.js'

/* Maps the neutral chart spec to Slack's data_visualization shape (renaming the camelCase axis
   fields to the snake_case Slack expects and dropping optional axis labels when unset), then
   clamps it to Slack's published limits. Returns null when the chart cannot be made valid, so the
   caller drops it rather than letting Slack reject the whole message with invalid_blocks. */
function toDataVisualizationBlock(title: string, chart: CuratedVibesChart): DataVisualizationBlock | null {
  if (chart.type === 'pie') {
    return normalizeDataVisualizationBlock({
      type: 'data_visualization',
      title,
      chart: { type: 'pie', segments: chart.segments }
    })
  }
  const { categories, xLabel, yLabel } = chart.axisConfig
  return normalizeDataVisualizationBlock({
    type: 'data_visualization',
    title,
    chart: {
      type: chart.type,
      series: chart.series,
      axis_config: {
        categories,
        ...(xLabel !== undefined && { x_label: xLabel }),
        ...(yLabel !== undefined && { y_label: yLabel })
      }
    }
  })
}

/* Renders a duration the way the recap footer does: "47 min" under an hour,
   "1h 4m" (or "1h" on the hour) once it crosses 60 minutes. */
function formatDuration(durationMinutes: number): string {
  const hours = Math.floor(durationMinutes / 60)
  const minutes = durationMinutes % 60
  if (hours === 0) return `${minutes} min`
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

/**
 * Assembles a {@link CuratedVibesData} payload into the recap card's Block Kit
 * grammar: a verdict header, an optional data-availability note, an optional
 * framing line, then each LLM-written standout as a section immediately followed
 * by its chart (a native data_visualization block, when the standout has one) and
 * an optional caption context block under the chart, then a divider and a footer
 * naming the event duration (both omitted for a trend card, which sets no single
 * duration). Slack allows at most two data_visualization blocks per message, so
 * charts beyond the first two charted standouts are dropped while their prose stays,
 * as is any chart that could not be clamped into Slack's limits. The standouts carry
 * their own numbers and source caveats in prose, so the two data sources stay
 * distinct without a separate rendered section, and the footer never repeats the
 * source labelling. The data_visualization block has no alt-text field, so the
 * caption (and the standout prose) is the accessible description of each chart.
 */
export default function renderCuratedVibesCard(data: CuratedVibesData): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: data.header, emoji: true }
    }
  ]

  // Used only when tracked data is missing: say so once, directly under the header.
  if (data.availabilityNote) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: data.availabilityNote }]
    })
  }

  if (data.framing) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: data.framing }
    })
  }

  // Slack rejects a message with more than two data_visualization blocks. Standouts
  // arrive most-notable first, so the card renders charts for at most the first two
  // charted standouts and lets any later standout keep its prose (which already names
  // the numbers) without a chart, rather than letting the whole post fail to send.
  const MAX_CHART_BLOCKS = 2
  let renderedCharts = 0

  for (const standout of data.standouts) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: standout.text }
    })
    // The chart sits directly after the insight it illustrates.
    if (standout.visual && renderedCharts < MAX_CHART_BLOCKS) {
      const chartBlock = toDataVisualizationBlock(standout.visual.title, standout.visual.chart)
      // A chart that cannot be clamped into Slack's limits is dropped so the standout prose (which
      // already names the numbers) still posts, rather than the whole message being rejected.
      if (chartBlock) {
        blocks.push(chartBlock as unknown as KnownBlock)
        renderedCharts += 1
        // A caption under the chart doubles as its screen-reader description, since
        // the data_visualization block carries no alt text of its own.
        if (standout.visual.caption) {
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: standout.visual.caption }]
          })
        }
      }
    }
  }

  // A single-event card ends with a duration footer; a trend card leaves durationMinutes unset
  // (one duration cannot describe many events), so it renders neither the footer nor its divider.
  if (data.durationMinutes !== undefined) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Event duration: ${formatDuration(data.durationMinutes)}` }]
    })
  }

  return blocks
}
