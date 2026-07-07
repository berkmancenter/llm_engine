import {
  DataVisualizationBlock,
  DATA_VIZ_LIMITS,
  normalizeDataVisualizationBlock,
  validateDataVisualizationBlock
} from '../../../../../src/adapters/slack/blocks/vibesAnalyst/dataVisualization.js'

const validLine: DataVisualizationBlock = {
  type: 'data_visualization',
  title: 'Posters per event',
  chart: {
    type: 'line',
    series: [
      {
        name: 'Posters',
        data: [
          { label: 'May 1', value: 8 },
          { label: 'May 30', value: 20 }
        ]
      }
    ],
    axis_config: { categories: ['May 1', 'May 30'], y_label: 'Posters' }
  }
}

const validPie: DataVisualizationBlock = {
  type: 'data_visualization',
  title: 'Where messages went',
  chart: {
    type: 'pie',
    segments: [
      { label: 'Public chat', value: 40 },
      { label: 'Private (bot)', value: 2 }
    ]
  }
}

describe('validateDataVisualizationBlock', () => {
  it('reports no problems for a valid line block', () => {
    expect(validateDataVisualizationBlock(validLine)).toEqual([])
  })

  it('reports no problems for a valid pie block', () => {
    expect(validateDataVisualizationBlock(validPie)).toEqual([])
  })

  it('flags a title over the character limit', () => {
    expect(validateDataVisualizationBlock({ ...validLine, title: 'x'.repeat(51) }).length).toBeGreaterThan(0)
  })

  it('flags a category label over the 20-character limit', () => {
    const block: DataVisualizationBlock = {
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'line',
        series: [{ name: 'Posters', data: [{ label: 'x'.repeat(21), value: 1 }] }],
        axis_config: { categories: ['x'.repeat(21)] }
      }
    }
    expect(validateDataVisualizationBlock(block).length).toBeGreaterThan(0)
  })

  it('flags a data point label that is not one of the categories', () => {
    const block: DataVisualizationBlock = {
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'line',
        series: [{ name: 'Posters', data: [{ label: 'ghost', value: 1 }] }],
        axis_config: { categories: ['May 1'] }
      }
    }
    expect(validateDataVisualizationBlock(block).length).toBeGreaterThan(0)
  })

  it('flags a pie segment whose value is not greater than zero', () => {
    const block: DataVisualizationBlock = {
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Public', value: 40 },
          { label: 'Private', value: 0 }
        ]
      }
    }
    expect(validateDataVisualizationBlock(block).length).toBeGreaterThan(0)
  })
})

describe('normalizeDataVisualizationBlock', () => {
  it('leaves a valid block unchanged and valid', () => {
    const out = normalizeDataVisualizationBlock(validLine)
    expect(out).toEqual(validLine)
    expect(validateDataVisualizationBlock(out as DataVisualizationBlock)).toEqual([])
  })

  it('clamps an over-long title to the limit', () => {
    const out = normalizeDataVisualizationBlock({ ...validLine, title: 'x'.repeat(60) })
    expect(out?.title).toHaveLength(DATA_VIZ_LIMITS.titleMaxLength)
  })

  it('truncates long labels while keeping categories and data points matched and valid', () => {
    const long = 'Regenerative Futures Monthly Roundtable'
    const block: DataVisualizationBlock = {
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'line',
        series: [
          {
            name: 'Posters',
            data: [
              { label: long, value: 5 },
              { label: 'May 1', value: 8 }
            ]
          }
        ],
        axis_config: { categories: [long, 'May 1'] }
      }
    }
    const out = normalizeDataVisualizationBlock(block)
    expect(out).not.toBeNull()
    if (out?.chart.type === 'pie' || !out) throw new Error('expected an axis chart')
    for (const category of out.chart.axis_config.categories) {
      expect(category.length).toBeLessThanOrEqual(DATA_VIZ_LIMITS.labelMaxLength)
    }
    expect(validateDataVisualizationBlock(out)).toEqual([])
  })

  it('dedupes categories that collide after truncation', () => {
    // Both names share their first 20 characters, so a naive truncate would produce a duplicate.
    const a = 'Community Roundtable Alpha'
    const b = 'Community Roundtable Beta'
    const block: DataVisualizationBlock = {
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'line',
        series: [
          {
            name: 'Posters',
            data: [
              { label: a, value: 3 },
              { label: b, value: 6 }
            ]
          }
        ],
        axis_config: { categories: [a, b] }
      }
    }
    const out = normalizeDataVisualizationBlock(block)
    if (out?.chart.type === 'pie' || !out) throw new Error('expected an axis chart')
    expect(new Set(out.chart.axis_config.categories).size).toBe(2)
    expect(validateDataVisualizationBlock(out)).toEqual([])
  })

  it('drops pie segments whose value is zero', () => {
    const out = normalizeDataVisualizationBlock({
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Public', value: 40 },
          { label: 'Private', value: 0 }
        ]
      }
    })
    if (out?.chart.type !== 'pie') throw new Error('expected a pie chart')
    expect(out.chart.segments).toHaveLength(1)
    expect(out.chart.segments[0].label).toBe('Public')
  })

  it('returns null for a pie whose segments are all non-positive', () => {
    const out = normalizeDataVisualizationBlock({
      type: 'data_visualization',
      title: 'T',
      chart: { type: 'pie', segments: [{ label: 'None', value: 0 }] }
    })
    expect(out).toBeNull()
  })

  it('returns null when an axis chart has no usable series data', () => {
    const out = normalizeDataVisualizationBlock({
      type: 'data_visualization',
      title: 'T',
      chart: {
        type: 'line',
        series: [{ name: 'Posters', data: [{ label: 'ghost', value: 1 }] }],
        axis_config: { categories: ['May 1'] }
      }
    })
    expect(out).toBeNull()
  })
})
