import announcementSchema from '../../../src/models/schemas/announcement.schema.js'

function segmentsOf(body: string): string[] {
  return announcementSchema.methods.segments.call({ body })
}

describe('announcementSchema.methods.segments', () => {
  it('splits blank-line-separated paragraphs into separate segments', () => {
    const body = 'Jane did a great job on the launch.\n\nBob fixed a critical bug under pressure.'
    expect(segmentsOf(body)).toEqual(['Jane did a great job on the launch.', 'Bob fixed a critical bug under pressure.'])
  })

  it('splits a single-paragraph numbered list into one segment per item', () => {
    const body = '1. Jane - great job on the launch\n2. Bob - excellent debugging\n3. Alex - stellar support'
    expect(segmentsOf(body)).toEqual([
      '1. Jane - great job on the launch',
      '2. Bob - excellent debugging',
      '3. Alex - stellar support'
    ])
  })

  it('splits a single-paragraph bulleted list into one segment per item', () => {
    const body = '* Jane did great\n• Bob did great'
    expect(segmentsOf(body)).toEqual(['* Jane did great', '• Bob did great'])
  })

  it('does not treat a hyphen-led line as a bullet, since a hyphen is also an ordinary dash/minus sign', () => {
    // A bare "-" is deliberately NOT a recognized bullet marker (unlike "*"/"•"): it's also an
    // ordinary dash or negative sign, so treating it as one would garble ordinary prose by
    // splitting mid-sentence.
    const negativeNumber = 'Revenue was strong this quarter.\n- 5% below forecast, still a solid result.'
    expect(segmentsOf(negativeNumber)).toEqual([negativeNumber])

    const dashLedAside = 'Congratulations to the whole team.\n- Especially impressive given the tight deadline.'
    expect(segmentsOf(dashLedAside)).toEqual([dashLedAside])
  })

  it('handles a prose paragraph followed by a numbered list', () => {
    const body = "Here's this week's kudos:\n\n1. Jane for the launch\n2. Bob for debugging"
    expect(segmentsOf(body)).toEqual(["Here's this week's kudos:", '1. Jane for the launch', '2. Bob for debugging'])
  })

  it('returns the whole body as one segment when there are no boundaries', () => {
    const body = 'Just a single short announcement with no structure at all.'
    expect(segmentsOf(body)).toEqual([body])
  })

  it('returns an empty array for empty or whitespace-only input', () => {
    expect(segmentsOf('')).toEqual([])
    expect(segmentsOf('   \n\n  ')).toEqual([])
  })

  it('does not treat an indented continuation line (no blank line) as a new segment', () => {
    const body = 'First paragraph.\n    Second line, just indented.'
    expect(segmentsOf(body)).toEqual([body])
  })

  it('collapses multiple consecutive blank lines without producing empty segments', () => {
    const body = 'First item.\n\n\n\nSecond item.'
    expect(segmentsOf(body)).toEqual(['First item.', 'Second item.'])
  })

  it('normalizes Windows line endings before segmenting', () => {
    const body = '1. Jane for the launch\r\n2. Bob for debugging'
    expect(segmentsOf(body)).toEqual(['1. Jane for the launch', '2. Bob for debugging'])
  })
})
