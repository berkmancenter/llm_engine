import type { KnownBlock, SectionBlock, HeaderBlock, ContextBlock } from '@slack/types'
import renderQualityReportCard from '../../../../src/adapters/slack/blocks/scorekeeper/qualityReportCard.js'
import type { QualityReportData } from '../../../../src/types/index.types.js'

function makeData(overrides: Partial<QualityReportData> = {}): QualityReportData {
  return {
    conversationName: 'AI in Education',
    conversationId: 'conv-1',
    evaluators: [
      { key: 'quality.correctness', mean: 0.85, min: 0.6, count: 10, lowScoreCount: 0 }
    ],
    overallMean: 0.85,
    tracesScored: 10,
    lowScoreTraces: [],
    totalLowScoreCount: 0,
    generatedAt: '2026-08-13T03:00:00.000Z',
    ...overrides
  }
}

function asSection(b: KnownBlock): SectionBlock {
  if (b.type !== 'section') throw new Error(`Expected section, got ${b.type}`)
  return b
}

function asHeader(b: KnownBlock): HeaderBlock {
  if (b.type !== 'header') throw new Error(`Expected header, got ${b.type}`)
  return b
}

function asContext(b: KnownBlock): ContextBlock {
  if (b.type !== 'context') throw new Error(`Expected context, got ${b.type}`)
  return b
}

function findSection(blocks: KnownBlock[], match: (text: string) => boolean): SectionBlock {
  const block = blocks.find((b) => b.type === 'section' && match((b as SectionBlock).text?.text ?? ''))
  if (!block) throw new Error('Section not found')
  return block as SectionBlock
}

describe('renderQualityReportCard()', () => {
  describe('header', () => {
    it('includes the conversation name in the header', () => {
      const blocks = renderQualityReportCard(makeData())
      const header = asHeader(blocks[0])
      expect(header.text.text).toContain('AI in Education')
    })
  })

  describe('summary section', () => {
    it('shows the overall mean and trace count', () => {
      const blocks = renderQualityReportCard(makeData({ overallMean: 0.76, tracesScored: 12 }))
      const summary = asSection(blocks[1])
      expect(summary.text?.text).toContain('0.76')
      expect(summary.text?.text).toContain('12 traces scored')
    })
  })

  describe('score table', () => {
    it('renders evaluator name formatted from dot-notation key', () => {
      const blocks = renderQualityReportCard(makeData())
      const table = findSection(blocks, (t) => t.includes('```'))
      expect(table.text?.text).toContain('Correctness')
    })

    it('formats underscore-separated names as title case', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [{ key: 'compliance.intervention_appropriateness', mean: 0.7, min: 0.5, count: 5, lowScoreCount: 0 }]
      }))
      const table = findSection(blocks, (t) => t.includes('```'))
      expect(table.text?.text).toContain('Intervention Appropriateness')
    })

    it('renders a category separator for dot-notation keys', () => {
      const blocks = renderQualityReportCard(makeData())
      const table = findSection(blocks, (t) => t.includes('```'))
      expect(table.text?.text).toContain('quality')
    })

    it('renders 🟢 for mean >= 0.7', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [{ key: 'quality.correctness', mean: 0.7, min: 0.7, count: 1, lowScoreCount: 0 }]
      }))
      const table = findSection(blocks, (t) => t.includes('```'))
      expect(table.text?.text).toContain('🟢')
    })

    it('renders 🟡 for mean >= 0.5 and < 0.7', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [{ key: 'quality.correctness', mean: 0.65, min: 0.5, count: 1, lowScoreCount: 0 }]
      }))
      const table = findSection(blocks, (t) => t.includes('```'))
      expect(table.text?.text).toContain('🟡')
    })

    it('renders 🔴 for mean < 0.5', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [{ key: 'quality.correctness', mean: 0.3, min: 0.1, count: 1, lowScoreCount: 1 }]
      }))
      const table = findSection(blocks, (t) => t.includes('```'))
      expect(table.text?.text).toContain('🔴')
    })

    it('groups multiple evaluators under their shared category', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [
          { key: 'quality.correctness', mean: 0.8, min: 0.6, count: 5, lowScoreCount: 0 },
          { key: 'quality.relevance', mean: 0.7, min: 0.5, count: 5, lowScoreCount: 0 }
        ]
      }))
      const text = findSection(blocks, (t) => t.includes('```')).text?.text ?? ''
      expect(text).toContain('quality')
      expect(text).toContain('Correctness')
      expect(text).toContain('Relevance')
    })

    it('renders evaluators with no category (no dot) without a category separator', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [{ key: 'interventionAppropriateness', mean: 0.9, min: 0.7, count: 5, lowScoreCount: 0 }]
      }))
      const text = findSection(blocks, (t) => t.includes('```')).text?.text ?? ''
      expect(text).toContain('Intervention Appropriateness')
      expect(text).not.toContain('──')
    })

    it('renders delta arrows when deltas are provided', () => {
      const blocks = renderQualityReportCard(makeData({
        deltas: { 'quality.correctness': 0.12 }
      }))
      const text = findSection(blocks, (t) => t.includes('```')).text?.text ?? ''
      expect(text).toContain('↑ +0.12')
    })

    it('renders ↓ arrow for negative delta', () => {
      const blocks = renderQualityReportCard(makeData({
        deltas: { 'quality.correctness': -0.15 }
      }))
      const text = findSection(blocks, (t) => t.includes('```')).text?.text ?? ''
      expect(text).toContain('↓ -0.15')
    })

    it('renders → when delta is below the display threshold', () => {
      const blocks = renderQualityReportCard(makeData({
        deltas: { 'quality.correctness': 0.01 }
      }))
      const text = findSection(blocks, (t) => t.includes('```')).text?.text ?? ''
      expect(text).toContain('→')
    })

    it('omits arrows when deltas are not provided', () => {
      const blocks = renderQualityReportCard(makeData())
      const text = findSection(blocks, (t) => t.includes('```')).text?.text ?? ''
      expect(text).not.toContain('↑')
      expect(text).not.toContain('↓')
      expect(text).not.toContain('→')
    })
  })

  describe('Trending Down section', () => {
    it('is not rendered when deltas are absent', () => {
      const blocks = renderQualityReportCard(makeData())
      expect(blocks.some((b) => b.type === 'section' && (b as SectionBlock).text?.text?.includes('Trending Down'))).toBe(false)
    })

    it('is not rendered when no evaluator is below the threshold', () => {
      const blocks = renderQualityReportCard(makeData({
        deltas: { 'quality.correctness': -0.05 }
      }))
      expect(blocks.some((b) => b.type === 'section' && (b as SectionBlock).text?.text?.includes('Trending Down'))).toBe(false)
    })

    it('appears when an evaluator delta is at or below -0.10', () => {
      const blocks = renderQualityReportCard(makeData({
        deltas: { 'quality.correctness': -0.10 }
      }))
      const section = findSection(blocks, (t) => t.includes('Trending Down'))
      expect(section.text?.text).toContain('Correctness')
      expect(section.text?.text).toContain('-0.10')
    })

    it('lists trending-down evaluators worst-first', () => {
      const blocks = renderQualityReportCard(makeData({
        evaluators: [
          { key: 'quality.correctness', mean: 0.6, min: 0.4, count: 5, lowScoreCount: 1 },
          { key: 'quality.relevance', mean: 0.5, min: 0.3, count: 5, lowScoreCount: 2 }
        ],
        deltas: { 'quality.correctness': -0.11, 'quality.relevance': -0.20 }
      }))
      const text = findSection(blocks, (t) => t.includes('Trending Down')).text?.text ?? ''
      expect(text.indexOf('Relevance')).toBeLessThan(text.indexOf('Correctness'))
    })
  })

  describe('Needs Review section', () => {
    it('is not rendered when there are no low-score traces', () => {
      const blocks = renderQualityReportCard(makeData({ lowScoreTraces: [], totalLowScoreCount: 0 }))
      expect(blocks.some((b) => b.type === 'section' && (b as SectionBlock).text?.text?.includes('Needs Review'))).toBe(false)
    })

    it('appears when there are low-score traces', () => {
      const blocks = renderQualityReportCard(makeData({
        lowScoreTraces: [{ runId: 'r1', url: 'https://smith.langchain.com/r1', lowScores: [{ key: 'compliance.tone', score: 0.2 }] }],
        totalLowScoreCount: 1
      }))
      expect(findSection(blocks, (t) => t.includes('Needs Review'))).toBeDefined()
    })

    it('shows the total count and a link when url is available', () => {
      const blocks = renderQualityReportCard(makeData({
        lowScoreTraces: [{ runId: 'run-abc123', url: 'https://smith.langchain.com/run-abc123', lowScores: [{ key: 'compliance.tone', score: 0.2 }] }],
        totalLowScoreCount: 1
      }))
      const text = findSection(blocks, (t) => t.includes('Needs Review')).text?.text ?? ''
      expect(text).toContain('1 trace')
      expect(text).toContain('https://smith.langchain.com/run-abc123')
      expect(text).toContain('Tone')
      expect(text).toContain('0.20')
    })

    it('falls back to a truncated run ID when url is null', () => {
      const blocks = renderQualityReportCard(makeData({
        lowScoreTraces: [{ runId: 'abcdefgh-1234', url: null, lowScores: [{ key: 'compliance.tone', score: 0.3 }] }],
        totalLowScoreCount: 1
      }))
      const text = findSection(blocks, (t) => t.includes('Needs Review')).text?.text ?? ''
      expect(text).toContain('abcdefgh')
    })

    it('shows "showing worst N of M" when totalLowScoreCount exceeds the number shown', () => {
      const traces = Array.from({ length: 5 }, (_, i) => ({
        runId: `run-${i}`,
        url: null,
        lowScores: [{ key: 'compliance.tone', score: 0.1 }]
      }))
      const text = findSection(
        renderQualityReportCard(makeData({ lowScoreTraces: traces, totalLowScoreCount: 23 })),
        (t) => t.includes('Needs Review')
      ).text?.text ?? ''
      expect(text).toContain('showing worst 5 of 23')
    })

    it('does not show the "showing worst" suffix when all low-score traces fit', () => {
      const text = findSection(
        renderQualityReportCard(makeData({
          lowScoreTraces: [{ runId: 'r1', url: null, lowScores: [{ key: 'compliance.tone', score: 0.3 }] }],
          totalLowScoreCount: 1
        })),
        (t) => t.includes('Needs Review')
      ).text?.text ?? ''
      expect(text).not.toContain('showing worst')
    })
  })

  describe('footer', () => {
    it('renders a context block with the generatedAt timestamp', () => {
      const blocks = renderQualityReportCard(makeData({ generatedAt: '2026-08-13T03:00:00.000Z' }))
      const context = asContext(blocks[blocks.length - 1])
      const element = context.elements[0]
      expect('text' in element && element.text).toContain('Generated at')
    })

    it('includes baseline sample count in footer when deltas are present', () => {
      const blocks = renderQualityReportCard(makeData({ deltas: {}, baselineSampleCount: 18 }))
      const context = asContext(blocks[blocks.length - 1])
      const element = context.elements[0]
      expect('text' in element && element.text).toContain('18 reports')
    })

    it('omits baseline note when deltas are absent', () => {
      const blocks = renderQualityReportCard(makeData())
      const context = asContext(blocks[blocks.length - 1])
      const element = context.elements[0]
      expect('text' in element && element.text).not.toContain('reports')
    })
  })

  describe('block structure', () => {
    it('renders header, summary, divider, table, divider, and footer with no extras', () => {
      const blocks = renderQualityReportCard(makeData())
      expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'divider', 'section', 'divider', 'context'])
    })

    it('inserts Trending Down section when a delta is below threshold', () => {
      const blocks = renderQualityReportCard(makeData({
        deltas: { 'quality.correctness': -0.15 }
      }))
      expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'divider', 'section', 'divider', 'section', 'divider', 'context'])
    })

    it('inserts Needs Review section when low-score traces exist', () => {
      const blocks = renderQualityReportCard(makeData({
        lowScoreTraces: [{ runId: 'r1', url: null, lowScores: [{ key: 'k', score: 0.1 }] }],
        totalLowScoreCount: 1
      }))
      expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'divider', 'section', 'divider', 'section', 'divider', 'context'])
    })
  })
})
