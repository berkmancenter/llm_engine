import { formatPollLine, interleaveSources } from '../../../../src/services/conceptGraph/index.js'

describe('formatPollLine', () => {
  it('states participation as a fraction of a trustworthy attendee count', () => {
    const line = formatPollLine(
      'Does the trust registry model scale?',
      [
        { text: 'Yes', count: 8 },
        { text: 'No', count: 5 }
      ],
      21
    )

    expect(line).toBe('Poll (13 of 21 attendees responded): "Does the trust registry model scale?" — Yes 8 (62%), No 5 (38%)')
  })

  it('falls back to a bare response count when the attendee denominator is untrustworthy', () => {
    const line = formatPollLine('Does the trust registry model scale?', [{ text: 'Yes', count: 8 }], undefined)

    expect(line).toBe('Poll (8 responses): "Does the trust registry model scale?" — Yes 8 (100%)')
  })

  it('uses singular phrasing for exactly one response', () => {
    const line = formatPollLine('Any objections?', [{ text: 'No', count: 1 }], undefined)

    expect(line).toContain('Poll (1 response):')
  })

  it('reports no responses rather than dividing by zero', () => {
    const line = formatPollLine('Any objections?', [{ text: 'No', count: 0 }], undefined)

    expect(line).toBe('Poll (0 responses): "Any objections?" — no responses recorded')
  })
})

describe('interleaveSources', () => {
  const t = (minutes: number) => new Date(2024, 0, 1, 0, minutes)

  it('orders messages and polls by when they actually happened, not by kind', () => {
    const { taggedLines } = interleaveSources([
      { kind: 'message', createdAt: t(0), body: 'first', messageId: 'm-a' },
      { kind: 'poll', createdAt: t(1), text: 'Poll (...)', pollId: 'p-a', question: 'Q1' },
      { kind: 'message', createdAt: t(2), body: 'second', messageId: 'm-b' }
    ])

    expect(taggedLines).toEqual(['[m1] first', '[p1] Poll (...)', '[m2] second'])
  })

  it('tags messages and polls in independent sequences', () => {
    const { taggedLines, sourceRefs, pollRefs } = interleaveSources([
      { kind: 'poll', createdAt: t(0), text: 'Poll one', pollId: 'p-a', question: 'Q1' },
      { kind: 'message', createdAt: t(1), body: 'hello', messageId: 'm-a' },
      { kind: 'poll', createdAt: t(2), text: 'Poll two', pollId: 'p-b', question: 'Q2' }
    ])

    expect(taggedLines).toEqual(['[p1] Poll one', '[m1] hello', '[p2] Poll two'])
    expect(sourceRefs.get('m1')).toBe('m-a')
    expect(pollRefs.get('p1')).toBe('p-a')
    expect(pollRefs.get('p2')).toBe('p-b')
  })

  it('excludes poll text from the quote-checker corpus, since it is not a participant statement', () => {
    const { texts } = interleaveSources([
      { kind: 'message', createdAt: t(0), body: 'hello', messageId: 'm-a' },
      { kind: 'poll', createdAt: t(1), text: 'Poll (...)', pollId: 'p-a', question: 'Q1' }
    ])

    expect(texts).toEqual(['hello'])
  })

  it('returns each poll a caller can pre-seed as an origin prompt, keyed by its tag', () => {
    const { polls } = interleaveSources([
      { kind: 'poll', createdAt: t(0), text: 'Poll (...)', pollId: 'p-a', question: 'Does it scale?' }
    ])

    expect(polls).toEqual([{ tag: 'p1', pollId: 'p-a', question: 'Does it scale?' }])
  })
})
