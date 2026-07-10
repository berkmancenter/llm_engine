import {
  resolveSummonedEvent,
  toPublicCandidates,
  EventResolution
} from '../../../../src/agents/vibesAnalyst/eventResolution.js'

/* A candidate public event the summon could resolve to. endMinutesAgo lets a test
   make one event more recent than another for the latest-in-topic case. */
function ev(id: string, name: string, topicName: string, endMinutesAgo = 0) {
  return { id, name, topicName, endTime: new Date(Date.parse('2026-06-01T00:00:00.000Z') - endMinutesAgo * 60 * 1000) }
}

function asAmbiguous(result: EventResolution) {
  if (result.status !== 'ambiguous') throw new Error(`expected ambiguous, got ${result.status}`)
  return result
}

describe('resolveSummonedEvent', () => {
  it('resolves a clear title match', () => {
    const candidates = [
      ev('1', 'Spring Town Hall 2026', 'Town Halls'),
      ev('2', 'Q3 Budget Review', 'Finance'),
      ev('3', 'Engineering Standup', 'Eng')
    ]

    const result = resolveSummonedEvent({ eventQuery: 'Spring Town Hall', latestInTopic: false }, candidates)

    expect(result).toEqual({ status: 'resolved', event: candidates[0] })
  })

  it('returns notFound when no title is close enough', () => {
    const candidates = [ev('1', 'Spring Town Hall 2026', 'Town Halls'), ev('2', 'Q3 Budget Review', 'Finance')]

    const result = resolveSummonedEvent({ eventQuery: 'Annual Holiday Gala', latestInTopic: false }, candidates)

    expect(result).toEqual({ status: 'notFound' })
  })

  it('flags ambiguity when two titles match closely', () => {
    const candidates = [
      ev('1', 'Spring Town Hall', 'Town Halls'),
      ev('2', 'Fall Town Hall', 'Town Halls'),
      ev('3', 'Q3 Budget Review', 'Finance')
    ]

    const result = resolveSummonedEvent({ eventQuery: 'Town Hall', latestInTopic: false }, candidates)

    expect(
      asAmbiguous(result)
        .candidates.map((candidate) => candidate.id)
        .sort()
    ).toEqual(['1', '2'])
  })

  it('resolves an exact title match even when near-duplicate titles fuzzy-score close behind', () => {
    // "Test Fancy Vibes #3" fuzzy-scores very close to "#1" and "#2" (they share every word but
    // the trailing number), close enough that the ambiguity margin alone would misfire even
    // though the query is a verbatim, unambiguous match for one real event.
    const candidates = [
      ev('1', 'Test Fancy Vibes #1', 'Series'),
      ev('2', 'Test Fancy Vibes #2', 'Series'),
      ev('3', 'Test Fancy Vibes #3', 'Series')
    ]

    const result = resolveSummonedEvent({ eventQuery: 'Test Fancy Vibes #3', latestInTopic: false }, candidates)

    expect(result).toEqual({ status: 'resolved', event: candidates[2] })
  })

  it('matches an exact title case-insensitively and ignoring surrounding whitespace', () => {
    const candidates = [ev('1', 'Test Fancy Vibes #1', 'Series'), ev('2', 'Test Fancy Vibes #2', 'Series')]

    const result = resolveSummonedEvent({ eventQuery: '  test fancy vibes #1  ', latestInTopic: false }, candidates)

    expect(result).toEqual({ status: 'resolved', event: candidates[0] })
  })

  it('still flags ambiguity when the exact same title is used by more than one event', () => {
    const candidates = [
      ev('1', 'Weekly Standup', 'Team A', 100),
      ev('2', 'Weekly Standup', 'Team B', 10)
    ]

    const result = resolveSummonedEvent({ eventQuery: 'Weekly Standup', latestInTopic: false }, candidates)

    expect(
      asAmbiguous(result)
        .candidates.map((candidate) => candidate.id)
        .sort()
    ).toEqual(['1', '2'])
  })

  it('picks the most recent event when asked for the latest in a topic', () => {
    const candidates = [
      ev('1', 'AI Ethics Session 1', 'AI Ethics', 1000),
      ev('2', 'AI Ethics Session 2', 'AI Ethics', 10), // most recent
      ev('3', 'Budget Review', 'Finance', 5)
    ]

    const result = resolveSummonedEvent({ eventQuery: 'AI Ethics', latestInTopic: true }, candidates)

    expect(result).toEqual({ status: 'resolved', event: candidates[1] })
  })

  it('returns notFound for latest-in-topic when no topic matches', () => {
    const candidates = [ev('1', 'AI Ethics Session 1', 'AI Ethics', 1000)]

    const result = resolveSummonedEvent({ eventQuery: 'Climate Policy', latestInTopic: true }, candidates)

    expect(result).toEqual({ status: 'notFound' })
  })

  it('resolves the single most recent event overall when asked for the latest with no topic', () => {
    const candidates = [
      ev('1', 'Spring Town Hall', 'Town Halls', 1000),
      ev('2', 'Budget Review', 'Finance', 5), // most recent
      ev('3', 'Engineering Standup', 'Eng', 500)
    ]

    const result = resolveSummonedEvent({ eventQuery: '', latestInTopic: false, latestOverall: true }, candidates)

    expect(result).toEqual({ status: 'resolved', event: candidates[1] })
  })

  it('returns notFound for latest-overall when there are no candidates', () => {
    const result = resolveSummonedEvent({ eventQuery: '', latestInTopic: false, latestOverall: true }, [])

    expect(result).toEqual({ status: 'notFound' })
  })
})

describe('toPublicCandidates', () => {
  const conversation = (over: Record<string, unknown> = {}) => ({
    _id: 'x',
    name: 'An Event',
    endTime: new Date('2026-01-01T00:00:00.000Z'),
    topic: { name: 'A Topic', private: false },
    ...over
  })

  it('keeps public ended events and maps them to candidates', () => {
    const result = toPublicCandidates([
      conversation({ _id: 'a', name: 'Spring Town Hall', topic: { name: 'Town Halls', private: false } })
    ])

    expect(result).toEqual([
      { id: 'a', name: 'Spring Town Hall', topicName: 'Town Halls', endTime: new Date('2026-01-01T00:00:00.000Z') }
    ])
  })

  it('drops events on a private topic so their titles never leak', () => {
    expect(toPublicCandidates([conversation({ topic: { name: 'Secret', private: true } })])).toEqual([])
  })

  it('drops events whose topic did not populate, failing closed', () => {
    expect(toPublicCandidates([conversation({ topic: undefined })])).toEqual([])
  })

  it('drops events that never ended', () => {
    expect(toPublicCandidates([conversation({ endTime: undefined })])).toEqual([])
  })
})
