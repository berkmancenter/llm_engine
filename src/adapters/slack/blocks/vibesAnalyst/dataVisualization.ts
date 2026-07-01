/* Slack's data_visualization block is not in @slack/types yet, so we model it here and enforce
   its published limits ourselves before sending. Slack rejects the whole message with
   invalid_blocks if any single limit is exceeded (a label one character too long sinks the
   entire post), so normalizeDataVisualizationBlock clamps a chart to the limits and drops it when
   it cannot be made valid, and validateDataVisualizationBlock reports violations for tests and
   diagnostics. Limits from:
   https://docs.slack.dev/reference/block-kit/blocks/data-visualization-block/ */

export interface DataVisualizationBlock {
  type: 'data_visualization'
  title: string
  chart:
    | {
        type: 'bar' | 'line' | 'area'
        series: { name: string; data: { label: string; value: number }[] }[]
        axis_config: { categories: string[]; x_label?: string; y_label?: string }
      }
    | { type: 'pie'; segments: { label: string; value: number }[] }
}

export const DATA_VIZ_LIMITS = {
  titleMaxLength: 50,
  seriesNameMaxLength: 20,
  labelMaxLength: 20,
  axisLabelMaxLength: 50,
  maxSeries: 12,
  maxDataPoints: 20,
  maxSegments: 12
} as const

/* Checks a block against every documented limit and returns a human-readable list of the
   violations (empty when it is valid). Used to assert chart builders and the normalizer produce
   sendable blocks, and available to log the reason if a real send is ever still rejected. */
export function validateDataVisualizationBlock(block: DataVisualizationBlock): string[] {
  const problems: string[] = []
  if (block.title.length > DATA_VIZ_LIMITS.titleMaxLength) {
    problems.push(`title exceeds ${DATA_VIZ_LIMITS.titleMaxLength} characters`)
  }

  const { chart } = block
  if (chart.type === 'pie') {
    if (chart.segments.length < 1 || chart.segments.length > DATA_VIZ_LIMITS.maxSegments) {
      problems.push(`pie needs 1 to ${DATA_VIZ_LIMITS.maxSegments} segments`)
    }
    chart.segments.forEach((segment, index) => {
      if (segment.label.length > DATA_VIZ_LIMITS.labelMaxLength) {
        problems.push(`segment ${index} label exceeds ${DATA_VIZ_LIMITS.labelMaxLength} characters`)
      }
      if (!(segment.value > 0)) problems.push(`segment ${index} value must be greater than 0`)
    })
    return problems
  }

  const { categories, x_label: xLabel, y_label: yLabel } = chart.axis_config
  if (categories.length < 1) problems.push('axis chart needs at least one category')
  if (new Set(categories).size !== categories.length) problems.push('categories must be unique')
  categories.forEach((category, index) => {
    if (category.length > DATA_VIZ_LIMITS.labelMaxLength) {
      problems.push(`category ${index} exceeds ${DATA_VIZ_LIMITS.labelMaxLength} characters`)
    }
  })
  if (chart.series.length < 1 || chart.series.length > DATA_VIZ_LIMITS.maxSeries) {
    problems.push(`chart needs 1 to ${DATA_VIZ_LIMITS.maxSeries} series`)
  }
  const seriesNames = new Set<string>()
  chart.series.forEach((series, seriesIndex) => {
    if (series.name.length > DATA_VIZ_LIMITS.seriesNameMaxLength) {
      problems.push(`series ${seriesIndex} name exceeds ${DATA_VIZ_LIMITS.seriesNameMaxLength} characters`)
    }
    if (seriesNames.has(series.name)) problems.push(`series ${seriesIndex} name is not unique`)
    seriesNames.add(series.name)
    if (series.data.length < 1 || series.data.length > DATA_VIZ_LIMITS.maxDataPoints) {
      problems.push(`series ${seriesIndex} needs 1 to ${DATA_VIZ_LIMITS.maxDataPoints} data points`)
    }
    series.data.forEach((point, pointIndex) => {
      if (!categories.includes(point.label)) {
        problems.push(`series ${seriesIndex} point ${pointIndex} label is not one of the categories`)
      }
    })
    // Slack requires every series to cover every category; a missing point is a rejected block.
    if (!categories.every((category) => series.data.some((point) => point.label === category))) {
      problems.push(`series ${seriesIndex} omits one or more categories`)
    }
  })
  if (xLabel && xLabel.length > DATA_VIZ_LIMITS.axisLabelMaxLength) problems.push('x_label is too long')
  if (yLabel && yLabel.length > DATA_VIZ_LIMITS.axisLabelMaxLength) problems.push('y_label is too long')
  return problems
}

/* Truncates to `max` and, if that collides with a label already used, appends a numeric suffix
   that still fits, so the returned string is both within the limit and unique. */
function toUniqueString(base: string, max: number, used: Set<string>): string {
  const clamped = base.slice(0, max)
  if (!used.has(clamped)) {
    used.add(clamped)
    return clamped
  }
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const candidate = `${clamped.slice(0, max - suffix.length)}${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/* Returns a copy of the block clamped to every documented limit, or null when it cannot be made
   valid (a pie with no positive segments, or an axis chart left with no series that covers the
   categories). The caller drops a null chart and keeps the surrounding prose, so one bad chart
   never fails the whole message. */
export function normalizeDataVisualizationBlock(block: DataVisualizationBlock): DataVisualizationBlock | null {
  const title = block.title.slice(0, DATA_VIZ_LIMITS.titleMaxLength)
  const { chart } = block

  if (chart.type === 'pie') {
    const segments = chart.segments
      .filter((segment) => segment.value > 0)
      .slice(0, DATA_VIZ_LIMITS.maxSegments)
      .map((segment) => ({ label: segment.label.slice(0, DATA_VIZ_LIMITS.labelMaxLength), value: segment.value }))
    if (segments.length === 0) return null
    return { type: 'data_visualization', title, chart: { type: 'pie', segments } }
  }

  // Build unique, length-capped categories, remembering the map from each original label so the
  // series data points can be re-pointed at the same normalized category.
  const usedCategories = new Set<string>()
  const labelMap = new Map<string, string>()
  for (const original of chart.axis_config.categories.slice(0, DATA_VIZ_LIMITS.maxDataPoints)) {
    if (!labelMap.has(original))
      labelMap.set(original, toUniqueString(original, DATA_VIZ_LIMITS.labelMaxLength, usedCategories))
  }
  const categories = [...labelMap.values()]
  if (categories.length === 0) return null

  // Re-point each series at the normalized categories and keep only series that still cover every
  // category, since Slack rejects a series that omits a data point.
  const remapped = chart.series.slice(0, DATA_VIZ_LIMITS.maxSeries).map((series) => ({
    name: series.name,
    data: series.data
      .filter((point) => labelMap.has(point.label))
      .slice(0, DATA_VIZ_LIMITS.maxDataPoints)
      .map((point) => ({ label: labelMap.get(point.label) as string, value: point.value }))
  }))
  const covering = remapped.filter((series) => series.data.length === categories.length)
  if (covering.length === 0) return null

  const usedNames = new Set<string>()
  const series = covering.map((entry) => ({
    name: toUniqueString(entry.name, DATA_VIZ_LIMITS.seriesNameMaxLength, usedNames),
    data: entry.data
  }))

  const { x_label: xLabel, y_label: yLabel } = chart.axis_config
  return {
    type: 'data_visualization',
    title,
    chart: {
      type: chart.type,
      series,
      axis_config: {
        categories,
        ...(xLabel !== undefined && { x_label: xLabel.slice(0, DATA_VIZ_LIMITS.axisLabelMaxLength) }),
        ...(yLabel !== undefined && { y_label: yLabel.slice(0, DATA_VIZ_LIMITS.axisLabelMaxLength) })
      }
    }
  }
}
