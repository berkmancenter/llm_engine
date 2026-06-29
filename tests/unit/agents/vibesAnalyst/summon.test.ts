import { jest } from '@jest/globals'

/* Event resolution (LLM extraction, candidate lookup, fuzzy matching) and the card
   pipeline are each tested in their own files. Here we mock them to drive handleSummon
   through its branches and check the wiring: which event it reads, what it replies, and
   that the access re-check stops a private event from ever being read. The access gate
   itself is the real one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExtract = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFindCandidates = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResolve = jest.fn<(...args: any[]) => any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildSummary = jest.fn<(...args: any[]) => Promise<any>>()
// Trend resolution and the comparative pipeline are tested in their own files; mocked here to
// drive handleSummon's trend branch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResolveTrendScope = jest.fn<(...args: any[]) => any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTrendEventCount = jest.fn<(...args: any[]) => number>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchTrendSnapshots = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildTrend = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/vibesAnalyst/eventResolution.js', () => ({
  extractEventReference: mockExtract,
  findCandidatePublicEvents: mockFindCandidates,
  resolveSummonedEvent: mockResolve,
  resolveTrendScope: mockResolveTrendScope,
  trendEventCount: mockTrendEventCount,
  fetchTrendSnapshots: mockFetchTrendSnapshots
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/buildSummary.js', () => ({
  default: mockBuildSummary
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/trendSummary.js', () => ({
  default: mockBuildTrend
}))

const {
  default: handleSummon,
  notFoundMessage,
  ambiguousMessage
} = await import('../../../../src/agents/vibesAnalyst/summon.js')
const { default: Conversation } = await import('../../../../src/models/conversation.model.js')

describe('handleSummon', () => {
  const vibesChannel = { name: 'vibesAnalyst' }
  const fakeLlm = { fakeLlm: true }
  const summonMessage = { _id: 'summon-msg', body: '@Vibes recap the Spring Town Hall' }

  // A fake agent context: __t marks it as an Agent for the access check, and the
  // allPublicTopics read grant covers any public event but no private one. The extra
  // channel proves the reply is filtered to the analyst's own channel.
  function buildContext() {
    return {
      __t: 'Agent',
      capabilities: { read: [{ type: 'allPublicTopics' }], write: [{ type: 'ownConversation' }] },
      conversation: { _id: 'va-conv', channels: [vibesChannel, { name: 'noise' }] }
    }
  }

  function mockResolvedConversation(topicPrivate: boolean) {
    jest.spyOn(Conversation, 'findById').mockReturnValue({
      populate: jest.fn<() => Promise<unknown>>().mockResolvedValue({
        _id: 'c1',
        name: 'Spring Town Hall',
        topic: { _id: 't1', private: topicPrivate }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }

  beforeEach(() => {
    jest.restoreAllMocks()
    mockExtract.mockReset()
    mockExtract.mockResolvedValue({ eventQuery: 'Spring Town Hall', latestInTopic: false, trend: false })
    mockFindCandidates.mockReset()
    mockFindCandidates.mockResolvedValue([])
    mockResolve.mockReset()
    mockBuildSummary.mockReset()
    // buildVibesSummary returns the card alongside the metrics; summon uses only the card.
    mockBuildSummary.mockResolvedValue({ renderData: { header: 'Recap' }, metrics: {} })
    mockResolveTrendScope.mockReset()
    mockResolveTrendScope.mockImplementation((_reference, candidates) => candidates)
    mockTrendEventCount.mockReset()
    mockTrendEventCount.mockReturnValue(5)
    mockFetchTrendSnapshots.mockReset()
    mockFetchTrendSnapshots.mockResolvedValue([])
    mockBuildTrend.mockReset()
    mockBuildTrend.mockResolvedValue({ header: 'Engagement trend', standouts: [] })
  })

  it('posts the engagement card threaded under the summon when the event resolves', async () => {
    mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
    mockResolvedConversation(false)
    const verifiedCard = { header: 'Recap', standouts: [] }
    mockBuildSummary.mockResolvedValue({ renderData: verifiedCard, metrics: {} })

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm)

    // Reads the message the user sent, then builds the card from the resolved event.
    expect(mockExtract).toHaveBeenCalledWith(summonMessage.body, fakeLlm)
    expect(mockBuildSummary).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }), fakeLlm)

    expect(responses).toHaveLength(1)
    const [response] = responses
    expect(response.responseKind).toBe('curatedVibesSummary')
    expect(response.renderData).toBe(verifiedCard)
    expect(response.parent).toBe('summon-msg') // threads under the question
    expect(response.channels).toEqual([vibesChannel]) // only the analyst's own channel
    expect(response.message).toContain('Spring Town Hall')
  })

  it('asks for a clearer name and reads nothing when no public event matches', async () => {
    mockResolve.mockReturnValue({ status: 'notFound' })

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm)

    expect(responses).toHaveLength(1)
    expect(responses[0].message).toBe(notFoundMessage('Spring Town Hall', []))
    expect(responses[0].parent).toBe('summon-msg')
    expect(responses[0].responseKind).toBeUndefined()
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  it('lists recent public events when nothing matches but there are events to suggest', async () => {
    mockExtract.mockResolvedValue({ eventQuery: 'past 2 events', latestInTopic: false, latestOverall: false })
    mockFindCandidates.mockResolvedValue([
      { id: '1', name: 'Mushrooms and the Future', topicName: 'Regenerative Futures', endTime: new Date('2026-06-10') },
      { id: '2', name: 'Soil Health 101', topicName: 'Regenerative Futures', endTime: new Date('2026-06-03') }
    ])
    mockResolve.mockReturnValue({ status: 'notFound' })

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm)

    expect(responses[0].message).toContain('Mushrooms and the Future')
    expect(responses[0].message).toContain('Soil Health 101')
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  it('lists the options when several public events match', async () => {
    const candidates = [
      { id: '1', name: 'Spring Town Hall' },
      { id: '2', name: 'Fall Town Hall' }
    ]
    mockResolve.mockReturnValue({ status: 'ambiguous', candidates })

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(responses[0].message).toBe(ambiguousMessage(candidates as any))
    expect(responses[0].message).toContain('Spring Town Hall')
    expect(responses[0].message).toContain('Fall Town Hall')
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  it('refuses and never reads content when the resolved event is on a private topic', async () => {
    mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
    mockResolvedConversation(true) // private topic, beyond the allPublicTopics grant

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm)

    expect(responses).toHaveLength(1)
    expect(responses[0].responseKind).toBeUndefined()
    expect(responses[0].message).toContain('can only recap public events')
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  describe('trend queries', () => {
    const trendMessage = { _id: 'summon-msg', body: '@Vibes how was engagement across the last 3 AI Ethics sessions?' }

    beforeEach(() => {
      mockExtract.mockResolvedValue({ eventQuery: 'AI Ethics', latestInTopic: false, trend: true, eventCount: 3 })
    })

    it('posts a comparative trend card when several snapshots are found', async () => {
      const snapshots = [{ conversationId: 'c3' }, { conversationId: 'c2' }, { conversationId: 'c1' }]
      mockFetchTrendSnapshots.mockResolvedValue(snapshots)
      const trendCard = { header: 'Engagement across 3 AI Ethics sessions', standouts: [] }
      mockBuildTrend.mockResolvedValue(trendCard)

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm)

      // The trend reads snapshots, not a live event, and never runs the single-event recap.
      expect(mockBuildTrend).toHaveBeenCalledWith(snapshots, fakeLlm)
      expect(mockBuildSummary).not.toHaveBeenCalled()
      expect(mockResolve).not.toHaveBeenCalled()

      expect(responses).toHaveLength(1)
      const [response] = responses
      expect(response.responseKind).toBe('curatedVibesSummary')
      expect(response.renderData).toBe(trendCard)
      expect(response.parent).toBe('summon-msg')
      expect(response.channels).toEqual([vibesChannel])
    })

    it('honours the resolved event count when fetching snapshots', async () => {
      mockTrendEventCount.mockReturnValue(3)
      mockFetchTrendSnapshots.mockResolvedValue([{ conversationId: 'c1' }, { conversationId: 'c2' }])

      await handleSummon(buildContext(), trendMessage, fakeLlm)

      expect(mockFetchTrendSnapshots).toHaveBeenCalledWith(expect.anything(), 3)
    })

    it('replies that there is no trend data when no snapshots exist yet', async () => {
      mockFetchTrendSnapshots.mockResolvedValue([])

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm)

      expect(responses).toHaveLength(1)
      expect(responses[0].responseKind).toBeUndefined()
      expect(responses[0].message).toMatch(/don't have stored metrics|can't compare/i)
      expect(mockBuildTrend).not.toHaveBeenCalled()
    })

    it('degrades to a single-event recap when only one event matches the trend', async () => {
      mockFetchTrendSnapshots.mockResolvedValue([{ conversationId: 'c1' }])
      mockResolvedConversation(false)
      const singleCard = { header: 'Recap', standouts: [] }
      mockBuildSummary.mockResolvedValue({ renderData: singleCard, metrics: {} })

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm)

      // One event is not a trend, so it recaps that event through the normal pipeline.
      expect(mockBuildTrend).not.toHaveBeenCalled()
      expect(mockBuildSummary).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }), fakeLlm)
      expect(responses[0].renderData).toBe(singleCard)
    })
  })
})
