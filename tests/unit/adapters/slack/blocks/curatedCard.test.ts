import renderCuratedVibesCard from '../../../../../src/adapters/slack/blocks/vibesAnalyst/curatedCard.js'
import renderResponseBlocks from '../../../../../src/adapters/slack/blocks/index.js'
import { CuratedVibesData } from '../../../../../src/types/index.types.js'

const negativeStandout = (): CuratedVibesData => ({
  header: 'The Future of Work — the room ran cool',
  framing: "Two things stood out today, and they lean the same way: people showed up, but didn't settle in.",
  standouts: [
    {
      text: '*More people left early than usual.* Tracked sessions show ~19% dropped off early, above your norm. Read it as a signal, not a hard count.',
      visual: {
        title: 'Participation over last 6 events',
        caption: 'Participation 32% today vs ~55% series average — below your norm.',
        chart: {
          type: 'line',
          series: [
            {
              name: 'Participation %',
              data: [
                { label: 'E1', value: 61 },
                { label: 'E2', value: 58 },
                { label: 'Today', value: 32 }
              ]
            }
          ],
          axisConfig: { categories: ['E1', 'E2', 'Today'], yLabel: 'Participation %' }
        }
      }
    },
    {
      text: '*And fewer people spoke.* 17 of 53 registered sent a message (32%), down from where your events usually land.',
      visual: {
        title: 'Audience devices',
        chart: {
          type: 'pie',
          segments: [
            { label: 'Smartphone', value: 14 },
            { label: 'Desktop', value: 7 }
          ]
        }
      }
    }
  ],
  durationMinutes: 58
})

describe('curated vibes card renderer', () => {
  it('renders the verdict header verbatim', () => {
    const header = renderCuratedVibesCard(negativeStandout()).find((block) => block.type === 'header')
    expect(header).toMatchObject({
      type: 'header',
      text: { type: 'plain_text', text: 'The Future of Work — the room ran cool' }
    })
  })

  it('renders the optional framing line as a section', () => {
    const serialized = JSON.stringify(renderCuratedVibesCard(negativeStandout()))
    expect(serialized).toContain("people showed up, but didn't settle in")
  })

  it('renders one section per standout, prose intact', () => {
    const sections = renderCuratedVibesCard(negativeStandout())
      .filter((block) => block.type === 'section')
      .map((block) => JSON.stringify(block))
    expect(sections.some((text) => text.includes('More people left early than usual'))).toBe(true)
    expect(sections.some((text) => text.includes('fewer people spoke'))).toBe(true)
  })

  it("renders a line/bar/area standout's chart as a data_visualization block right after its insight", () => {
    const blocks = renderCuratedVibesCard(negativeStandout())
    const firstStandoutIndex = blocks.findIndex(
      (block) => block.type === 'section' && JSON.stringify(block).includes('More people left early')
    )
    const nextBlock = blocks[firstStandoutIndex + 1]
    expect(nextBlock).toMatchObject({
      type: 'data_visualization',
      title: 'Participation over last 6 events',
      chart: {
        type: 'line',
        series: [
          {
            name: 'Participation %',
            data: [
              { label: 'E1', value: 61 },
              { label: 'E2', value: 58 },
              { label: 'Today', value: 32 }
            ]
          }
        ],
        // axisConfig is mapped to Slack's snake_case axis_config / y_label.
        axis_config: { categories: ['E1', 'E2', 'Today'], y_label: 'Participation %' }
      }
    })
  })

  it("renders a pie standout's chart with segments under the chart object", () => {
    const block = renderCuratedVibesCard(negativeStandout()).find(
      (b) => (b as { type: string }).type === 'data_visualization' && JSON.stringify(b).includes('Audience devices')
    )
    expect(block).toMatchObject({
      type: 'data_visualization',
      title: 'Audience devices',
      chart: {
        type: 'pie',
        segments: [
          { label: 'Smartphone', value: 14 },
          { label: 'Desktop', value: 7 }
        ]
      }
    })
  })

  it('omits the x_label when the axis config does not set one', () => {
    const block = renderCuratedVibesCard(negativeStandout()).find(
      (b) => (b as { type: string }).type === 'data_visualization' && JSON.stringify(b).includes('Participation %')
    )
    expect(JSON.stringify(block)).not.toContain('x_label')
  })

  it("renders a visual's caption as a context block directly after its chart", () => {
    const blocks = renderCuratedVibesCard(negativeStandout())
    const chartIndex = blocks.findIndex((b) => (b as { type: string }).type === 'data_visualization')
    const afterChart = blocks[chartIndex + 1]
    expect(afterChart).toMatchObject({ type: 'context' })
    expect(JSON.stringify(afterChart)).toContain('Participation 32% today vs ~55% series average')
  })

  it('omits the caption context when a visual has no caption', () => {
    const data = negativeStandout()
    delete data.standouts[0].visual!.caption
    const blocks = renderCuratedVibesCard(data)
    const chartIndex = blocks.findIndex((b) => (b as { type: string }).type === 'data_visualization')
    // With no caption, the block after the chart is the next standout, not a context caption.
    expect((blocks[chartIndex + 1] as { type: string }).type).not.toBe('context')
  })

  it('renders at most two data_visualization blocks, since Slack rejects more', () => {
    const data = negativeStandout()
    // A third charted standout. Slack caps a message at two data_visualization blocks,
    // so the card must drop the extra chart while keeping the standout's prose.
    data.standouts.push({
      text: '*A few voices carried the room.* The top poster sent 5 of 12 messages (42%).',
      visual: {
        title: 'Share of messages',
        chart: {
          type: 'pie',
          segments: [
            { label: 'Top poster', value: 5 },
            { label: 'Everyone else', value: 7 }
          ]
        }
      }
    })
    const blocks = renderCuratedVibesCard(data)
    const charts = blocks.filter((block) => (block as { type: string }).type === 'data_visualization')
    expect(charts).toHaveLength(2)
    // The third standout still renders its prose, just without a chart.
    expect(JSON.stringify(blocks)).toContain('A few voices carried the room')
  })

  it('omits the chart for a standout that has no visual', () => {
    const data = negativeStandout()
    delete data.standouts[1].visual
    const charts = renderCuratedVibesCard(data).filter((block) => (block as { type: string }).type === 'data_visualization')
    expect(charts).toHaveLength(1)
  })

  it('no longer renders a tip callout', () => {
    const blocks = renderCuratedVibesCard(negativeStandout())
    expect(blocks.some((block) => block.type === 'rich_text')).toBe(false)
    expect(JSON.stringify(blocks)).not.toContain('Tip:')
  })

  it('renders a divider before the footer', () => {
    expect(renderCuratedVibesCard(negativeStandout()).some((block) => block.type === 'divider')).toBe(true)
  })

  it('renders only the event duration in the footer, no source or freshness line', () => {
    // The footer is the last context block (caption contexts come earlier).
    const contexts = renderCuratedVibesCard(negativeStandout()).filter((block) => block.type === 'context')
    const footer = contexts[contexts.length - 1]
    expect(JSON.stringify(footer)).toContain('Event duration: 58 min')
    expect(JSON.stringify(footer)).not.toContain('exact')
    expect(JSON.stringify(footer)).not.toContain('undercount')
  })

  it('formats durations over an hour as hours and minutes', () => {
    const data = negativeStandout()
    data.durationMinutes = 64
    const contexts = renderCuratedVibesCard(data).filter((block) => block.type === 'context')
    const footer = contexts[contexts.length - 1]
    expect(JSON.stringify(footer)).toContain('Event duration: 1h 4m')
  })

  it('never renders an actions or button block', () => {
    const blocks = renderCuratedVibesCard(negativeStandout())
    expect(blocks.some((block) => block.type === 'actions')).toBe(false)
    expect(JSON.stringify(blocks)).not.toContain('Open full report')
  })

  it('renders the availability note as a context block under the header when present', () => {
    const data = negativeStandout()
    data.availabilityNote = 'No tracked-session data this time, so this is built only on the messages people sent.'
    const blocks = renderCuratedVibesCard(data)
    expect(blocks[0].type).toBe('header')
    expect(blocks[1].type).toBe('context')
    expect(JSON.stringify(blocks[1])).toContain('No tracked-session data this time')
  })

  it('omits the framing section when no framing is provided', () => {
    const data = negativeStandout()
    delete data.framing
    expect(JSON.stringify(renderCuratedVibesCard(data))).not.toContain("people showed up, but didn't settle in")
  })

  it('normalizes an over-long chart label so the rendered block stays within Slack limits', () => {
    const data = negativeStandout()
    data.standouts[0].visual!.chart = {
      type: 'line',
      series: [{ name: 'Participation %', data: [{ label: 'Really Long Event Name Here', value: 10 }] }],
      axisConfig: { categories: ['Really Long Event Name Here'], yLabel: 'Participation %' }
    }
    const block = renderCuratedVibesCard(data).find((b) => (b as { type: string }).type === 'data_visualization')
    // The 27-character label must be clamped to 20 before it could ever reach Slack.
    expect(JSON.stringify(block)).not.toContain('Really Long Event Name Here')
  })

  it('omits the duration footer and its divider for a trend card that spans multiple events', () => {
    const data = negativeStandout()
    // A trend card leaves durationMinutes unset, since a single duration cannot describe many events.
    delete (data as { durationMinutes?: number }).durationMinutes
    const blocks = renderCuratedVibesCard(data)
    expect(JSON.stringify(blocks)).not.toContain('Event duration')
    expect(blocks.some((block) => block.type === 'divider')).toBe(false)
  })
})

describe('slack block registry: curated card', () => {
  it('routes curatedVibesSummary through the curated renderer', () => {
    const data = negativeStandout()
    expect(renderResponseBlocks('curatedVibesSummary', data)).toEqual(renderCuratedVibesCard(data))
  })

  it('returns undefined for an unknown responseKind', () => {
    expect(renderResponseBlocks('somethingElse', negativeStandout())).toBeUndefined()
  })

  it('returns undefined when responseKind is absent', () => {
    expect(renderResponseBlocks(undefined, negativeStandout())).toBeUndefined()
  })
})
