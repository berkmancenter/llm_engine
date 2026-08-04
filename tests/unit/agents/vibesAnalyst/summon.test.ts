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
const mockResolveNamedTrendScope = jest.fn<(...args: any[]) => any>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTrendEventCount = jest.fn<(...args: any[]) => number>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetchTrendSnapshots = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockComputeTrendViewsLive = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildTrend = jest.fn<(...args: any[]) => Promise<any>>()
// buildSnapshotPayload is exercised in its own service tests; here it only needs to shape
// whatever metricsContext gets carried alongside a card.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockBuildSnapshotPayload = jest.fn<(...args: any[]) => any>()
// Follow-up resolution and answering are exercised in their own file; mocked here to drive
// handleSummon's offTopic-to-follow-up routing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResolveFollowUpContext = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAnswerFollowUp = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResolveDisambiguationContext = jest.fn<(...args: any[]) => Promise<any>>()
// The smalltalk reply (greeting/help/offTopic) is the only place handleSummon calls the LLM
// chain directly; mocked here so those tests can drive both the happy path and its fallback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetChatPromptResponse = jest.fn<(...args: any[]) => Promise<any>>()
// hasHistorianAgent and computeConversationMetrics back the new "question" intent branch
// (handleQuestionSummon); mocked here the same way the rest of the pipeline is.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockHasHistorianAgent = jest.fn<(...args: any[]) => Promise<any>>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockComputeConversationMetrics = jest.fn<(...args: any[]) => Promise<any>>()
// The on-demand agent loop (its tools and its own fact-check) is exercised in its own file;
// mocked here to drive the escalation from "the precomputed numbers cannot answer this" to a
// computation run over the event.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAnswerWithOnDemandMetrics = jest.fn<(...args: any[]) => Promise<any>>()

jest.unstable_mockModule('../src/agents/vibesAnalyst/onDemand.js', () => ({
  default: mockAnswerWithOnDemandMetrics
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/eventResolution.js', () => ({
  extractEventReference: mockExtract,
  findCandidatePublicEvents: mockFindCandidates,
  resolveSummonedEvent: mockResolve,
  resolveTrendScope: mockResolveTrendScope,
  resolveNamedTrendScope: mockResolveNamedTrendScope,
  trendEventCount: mockTrendEventCount,
  fetchTrendSnapshots: mockFetchTrendSnapshots,
  computeTrendViewsLive: mockComputeTrendViewsLive,
  MAX_TREND_EVENTS: 10
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/buildSummary.js', () => ({
  default: mockBuildSummary,
  hasHistorianAgent: mockHasHistorianAgent
}))
jest.unstable_mockModule('../src/services/conversationAnalytics.service.js', () => ({
  default: { computeConversationMetrics: mockComputeConversationMetrics }
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/trendSummary.js', () => ({
  default: mockBuildTrend
}))
jest.unstable_mockModule('../src/services/conversationMetricsSnapshot.service.js', () => ({
  buildSnapshotPayload: mockBuildSnapshotPayload
}))
jest.unstable_mockModule('../src/agents/vibesAnalyst/followUp.js', () => ({
  resolveFollowUpContext: mockResolveFollowUpContext,
  answerFollowUp: mockAnswerFollowUp,
  resolveDisambiguationContext: mockResolveDisambiguationContext
}))
jest.unstable_mockModule('../src/agents/helpers/llmChain.js', () => ({
  getChatPromptResponse: mockGetChatPromptResponse
}))

const {
  default: handleSummon,
  notFoundMessage,
  ambiguousMessage,
  greetingMessage,
  helpMessage,
  offTopicMessage,
  namedTrendNotFoundMessage,
  unanswerableQuestionMessage
} = await import('../../../../src/agents/vibesAnalyst/summon.js')
const { default: Conversation } = await import('../../../../src/models/conversation.model.js')
const { default: logger } = await import('../../../../src/config/logger.js')

describe('handleSummon', () => {
  const vibesChannel = { name: 'vibesAnalyst' }
  // Two distinct models so the tests can prove routing: the main Opus-tier model writes the
  // cards, the faster classification model parses the summon (extractEventReference).
  const fakeLlm = { fakeLlm: true }
  const fastLlm = { fastLlm: true }
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
    mockResolveNamedTrendScope.mockReset()
    mockResolveNamedTrendScope.mockReturnValue({ resolved: [], unresolved: [] })
    mockTrendEventCount.mockReset()
    mockTrendEventCount.mockReturnValue(5)
    mockFetchTrendSnapshots.mockReset()
    mockFetchTrendSnapshots.mockResolvedValue([])
    mockComputeTrendViewsLive.mockReset()
    mockComputeTrendViewsLive.mockResolvedValue([])
    mockBuildTrend.mockReset()
    mockBuildTrend.mockResolvedValue({ header: 'Engagement trend', standouts: [] })
    mockBuildSnapshotPayload.mockReset()
    mockBuildSnapshotPayload.mockReturnValue({ posterCount: 0 })
    mockResolveFollowUpContext.mockReset()
    mockResolveFollowUpContext.mockResolvedValue(null)
    mockAnswerFollowUp.mockReset()
    mockAnswerFollowUp.mockResolvedValue({ answerable: false, text: null })
    mockResolveDisambiguationContext.mockReset()
    mockResolveDisambiguationContext.mockResolvedValue(null)
    mockGetChatPromptResponse.mockReset()
    mockGetChatPromptResponse.mockResolvedValue({ text: 'An in-voice smalltalk reply.' })
    mockHasHistorianAgent.mockReset()
    mockHasHistorianAgent.mockResolvedValue(false)
    mockComputeConversationMetrics.mockReset()
    mockComputeConversationMetrics.mockResolvedValue({})
    mockAnswerWithOnDemandMetrics.mockReset()
    mockAnswerWithOnDemandMetrics.mockResolvedValue(null)
  })

  it('posts the engagement card threaded under the summon when the event resolves', async () => {
    mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
    mockResolvedConversation(false)
    const verifiedCard = { header: 'Recap', standouts: [] }
    mockBuildSummary.mockResolvedValue({ renderData: verifiedCard, metrics: {} })

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm, fastLlm)

    // Parses the message on the faster classification model, then builds the card on the main
    // model, handing the fast model down so the card's own annotation passes reuse it.
    expect(mockExtract).toHaveBeenCalledWith(summonMessage.body, fastLlm)
    expect(mockBuildSummary).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }), fakeLlm, fastLlm)

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

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm, fastLlm)

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

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm, fastLlm)

    expect(responses[0].message).toContain('Mushrooms and the Future')
    expect(responses[0].message).toContain('Soil Health 101')
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  it('lists the options when several public events match, carrying the list on the reply for a later bare-name reply to match against', async () => {
    const candidates = [
      { id: '1', name: 'Spring Town Hall' },
      { id: '2', name: 'Fall Town Hall' }
    ]
    mockResolve.mockReturnValue({ status: 'ambiguous', candidates })

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm, fastLlm)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(responses[0].message).toBe(ambiguousMessage(candidates as any))
    expect(responses[0].message).toContain('Spring Town Hall')
    expect(responses[0].message).toContain('Fall Town Hall')
    expect(responses[0].responseKind).toBe('eventDisambiguation')
    expect(responses[0].metricsContext).toBe(candidates)
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  describe('continuing a pending disambiguation', () => {
    // resolveDisambiguationContext finds VA's own "which one did you mean?" list in the thread;
    // these tests drive handleSummon's branch that answers a bare reply against that list
    // directly, instead of letting extractEventReference's classification decide.
    const pendingCandidates = [
      { id: '1', name: 'Test Fancy Vibes #1', topicName: 'Series', endTime: new Date('2026-06-01') },
      { id: '3', name: 'Test Fancy Vibes #3', topicName: 'Series', endTime: new Date('2026-06-03') }
    ]
    const bareReplyMessage = { _id: 'reply-msg', body: 'Test Fancy Vibes #3', parentMessage: 'disambig-msg' }

    it('recaps the event named in a bare reply that answers a pending disambiguation, without trusting the classifier', async () => {
      mockResolveDisambiguationContext.mockResolvedValue(pendingCandidates)
      mockResolve.mockReturnValue({ status: 'resolved', event: pendingCandidates[1] })
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })
      mockResolvedConversation(false)
      const verifiedCard = { header: 'Recap', standouts: [] }
      mockBuildSummary.mockResolvedValue({ renderData: verifiedCard, metrics: {} })

      const responses = await handleSummon(buildContext(), bareReplyMessage, fakeLlm, fastLlm)

      expect(mockResolveDisambiguationContext).toHaveBeenCalledWith(bareReplyMessage, 'va-conv')
      expect(responses).toHaveLength(1)
      expect(responses[0].responseKind).toBe('curatedVibesSummary')
      expect(responses[0].renderData).toBe(verifiedCard)
    })

    it('re-lists a still-ambiguous pending answer instead of falling back to the classifier', async () => {
      mockResolveDisambiguationContext.mockResolvedValue(pendingCandidates)
      mockResolve.mockReturnValue({ status: 'ambiguous', candidates: pendingCandidates })
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })

      const responses = await handleSummon(
        buildContext(),
        { ...bareReplyMessage, body: 'Test Fancy Vibes' },
        fakeLlm,
        fastLlm
      )

      expect(responses[0].responseKind).toBe('eventDisambiguation')
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })

    it('falls through to normal handling when the reply matches none of the pending options', async () => {
      mockResolveDisambiguationContext.mockResolvedValue(pendingCandidates)
      mockResolve.mockReturnValue({ status: 'notFound' })
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })

      const responses = await handleSummon(buildContext(), { ...bareReplyMessage, body: 'never mind' }, fakeLlm, fastLlm)

      // Classified offTopic by extractEventReference, same as any other unaddressed reply: no
      // event recapped, no disambiguation re-posted.
      expect(responses[0].responseKind).toBeUndefined()
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })
  })

  it('refuses and never reads content when the resolved event is on a private topic', async () => {
    mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
    mockResolvedConversation(true) // private topic, beyond the allPublicTopics grant

    const responses = await handleSummon(buildContext(), summonMessage, fakeLlm, fastLlm)

    expect(responses).toHaveLength(1)
    expect(responses[0].responseKind).toBeUndefined()
    expect(responses[0].message).toContain('can only recap public events')
    expect(mockBuildSummary).not.toHaveBeenCalled()
  })

  describe('non-recap intents', () => {
    // A member can address VA without asking for a recap: a greeting, a "what can you do?",
    // or something off-topic. These get a canned reply, never the not-found event dump, and
    // never read an event.
    const recent = [
      { id: '1', name: 'Mushrooms and the Future', topicName: 'Regenerative Futures', endTime: new Date('2026-06-10') },
      { id: '2', name: 'Soil Health 101', topicName: 'Regenerative Futures', endTime: new Date('2026-06-03') }
    ]

    beforeEach(() => {
      mockFindCandidates.mockResolvedValue(recent)
    })

    it('answers a greeting with an in-voice reply from the smalltalk model, reading nothing', async () => {
      mockExtract.mockResolvedValue({ intent: 'greeting', eventQuery: '', latestInTopic: false, trend: false })
      mockGetChatPromptResponse.mockResolvedValue({ text: 'Here, and reading the room. Ask me about a past event.' })

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes are you there?' }, fakeLlm, fastLlm)

      // Runs on the main model, not the fast classification one, since wording quality and
      // variation are the point here.
      expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
        fakeLlm,
        expect.any(String),
        expect.any(String),
        {
          intent: 'greeting',
          message: '@Vibes are you there?',
          recentEventsJson: JSON.stringify(['Mushrooms and the Future', 'Soil Health 101'])
        },
        undefined,
        expect.anything()
      )
      expect(responses).toHaveLength(1)
      expect(responses[0].responseKind).toBeUndefined()
      expect(responses[0].message).toBe('Here, and reading the room. Ask me about a past event.')
      expect(mockResolve).not.toHaveBeenCalled()
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })

    it('answers a help question with an in-voice reply from the smalltalk model', async () => {
      mockExtract.mockResolvedValue({ intent: 'help', eventQuery: '', latestInTopic: false, trend: false })
      mockGetChatPromptResponse.mockResolvedValue({ text: 'I read past public events and tell you what stood out.' })

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes what can you do?' }, fakeLlm, fastLlm)

      expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
        fakeLlm,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ intent: 'help' }),
        undefined,
        expect.anything()
      )
      expect(responses[0].message).toBe('I read past public events and tell you what stood out.')
      expect(mockResolve).not.toHaveBeenCalled()
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })

    it('falls back to the static greeting when the smalltalk model call fails', async () => {
      mockExtract.mockResolvedValue({ intent: 'greeting', eventQuery: '', latestInTopic: false, trend: false })
      mockGetChatPromptResponse.mockRejectedValue(new Error('model timeout'))

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes are you there?' }, fakeLlm, fastLlm)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(responses[0].message).toBe(greetingMessage(recent as any))
    })

    it('falls back to the static help message when the smalltalk model call fails', async () => {
      mockExtract.mockResolvedValue({ intent: 'help', eventQuery: '', latestInTopic: false, trend: false })
      mockGetChatPromptResponse.mockRejectedValue(new Error('model timeout'))

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes what can you do?' }, fakeLlm, fastLlm)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(responses[0].message).toBe(helpMessage(recent as any))
    })

    it('deflects an off-topic message with an in-voice reply, reading nothing', async () => {
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })
      mockGetChatPromptResponse.mockResolvedValue({ text: "That's outside what I read. Ask me about a past event." })

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes whats the weather?' }, fakeLlm, fastLlm)

      expect(mockGetChatPromptResponse).toHaveBeenCalledWith(
        fakeLlm,
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ intent: 'offTopic' }),
        undefined,
        expect.anything()
      )
      expect(responses[0].message).toBe("That's outside what I read. Ask me about a past event.")
      expect(mockResolve).not.toHaveBeenCalled()
      expect(mockBuildSummary).not.toHaveBeenCalled()
      // Not a threaded reply, so there is nothing to follow up on.
      expect(mockResolveFollowUpContext).toHaveBeenCalled()
      expect(mockAnswerFollowUp).not.toHaveBeenCalled()
    })

    it('falls back to the static off-topic message when the smalltalk model call fails', async () => {
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })
      mockGetChatPromptResponse.mockRejectedValue(new Error('model timeout'))

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes whats the weather?' }, fakeLlm, fastLlm)

      expect(responses[0].message).toBe(offTopicMessage())
    })

    it('answers a threaded follow-up question from a prior card instead of deflecting it', async () => {
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })
      const priorMetrics = [{ posterCount: 12, lurkerCount: 68, participantCount: 80 }]
      mockResolveFollowUpContext.mockResolvedValue(priorMetrics)
      mockAnswerFollowUp.mockResolvedValue({
        answerable: true,
        text: '80 people showed up as tracked visits, and 12 of them posted.'
      })
      const followUpMessage = { _id: 'm', parentMessage: 'root-1', body: 'how many total participants were there?' }

      const responses = await handleSummon(buildContext(), followUpMessage, fakeLlm, fastLlm)

      expect(mockResolveFollowUpContext).toHaveBeenCalledWith(followUpMessage, 'va-conv')
      expect(mockAnswerFollowUp).toHaveBeenCalledWith(followUpMessage.body, priorMetrics, fakeLlm)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBe('80 people showed up as tracked visits, and 12 of them posted.')
      expect(responses[0].responseKind).toBeUndefined()
      expect(responses[0].parent).toBe('m')
      expect(mockResolve).not.toHaveBeenCalled()
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })

    it('falls back to the off-topic smalltalk reply when the follow-up question is not answerable from the prior card', async () => {
      mockExtract.mockResolvedValue({ intent: 'offTopic', eventQuery: '', latestInTopic: false, trend: false })
      mockResolveFollowUpContext.mockResolvedValue([{ posterCount: 12 }])
      mockAnswerFollowUp.mockResolvedValue({ answerable: false, text: null })
      mockGetChatPromptResponse.mockResolvedValue({ text: "That's outside what I read." })
      const followUpMessage = { _id: 'm', parentMessage: 'root-1', body: 'what did the speaker actually say?' }

      const responses = await handleSummon(buildContext(), followUpMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toBe("That's outside what I read.")
    })

    it('guides instead of dumping the event list when a recap names no event at all', async () => {
      // Even if a bare greeting slips through tagged as a recap, an empty query must never
      // reach the not-found dump; it falls back to the same help guidance.
      mockExtract.mockResolvedValue({
        intent: 'recap',
        eventQuery: '   ',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })

      const responses = await handleSummon(buildContext(), { _id: 'm', body: '@Vibes are you there?' }, fakeLlm, fastLlm)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(responses[0].message).toBe(helpMessage(recent as any))
      expect(mockResolve).not.toHaveBeenCalled()
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })
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

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm, fastLlm)

      // Stored snapshots are preferred: no live recompute, no single-event recap.
      expect(mockBuildTrend).toHaveBeenCalledWith(snapshots, fakeLlm)
      expect(mockComputeTrendViewsLive).not.toHaveBeenCalled()
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

      await handleSummon(buildContext(), trendMessage, fakeLlm, fastLlm)

      expect(mockFetchTrendSnapshots).toHaveBeenCalledWith(expect.anything(), 3)
    })

    it('recomputes the scoped events live and posts a trend when no snapshots exist yet', async () => {
      // The events were never snapshotted (never stopped since the feature shipped, backfill
      // not run), but their metrics can still be computed on demand, so the trend answers.
      mockFetchTrendSnapshots.mockResolvedValue([])
      const liveViews = [{ conversationId: 'c3' }, { conversationId: 'c2' }, { conversationId: 'c1' }]
      mockComputeTrendViewsLive.mockResolvedValue(liveViews)
      const trendCard = { header: 'Engagement trend', standouts: [] }
      mockBuildTrend.mockResolvedValue(trendCard)

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm, fastLlm)

      expect(mockComputeTrendViewsLive).toHaveBeenCalled()
      expect(mockBuildTrend).toHaveBeenCalledWith(liveViews, fakeLlm)
      expect(mockBuildSummary).not.toHaveBeenCalled()
      expect(responses[0].renderData).toBe(trendCard)
    })

    it('warns to run the backfill when it recomputes a trend the snapshot store should have held', async () => {
      // Snapshots came back short (a metrics-version bump orphaned them, or the store never got
      // seeded) but the events still recompute into a real multi-event trend. That gap is silent
      // otherwise, so it should log the remedy.
      const warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(logger)
      mockFetchTrendSnapshots.mockResolvedValue([])
      mockComputeTrendViewsLive.mockResolvedValue([
        { conversationId: 'c3' },
        { conversationId: 'c2' },
        { conversationId: 'c1' }
      ])
      mockBuildTrend.mockResolvedValue({ header: 'Engagement trend', standouts: [] })

      await handleSummon(buildContext(), trendMessage, fakeLlm, fastLlm)

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/backfill/i))
      warnSpy.mockRestore()
    })

    it('says there is nothing to compare when neither snapshots nor live events exist', async () => {
      const warnSpy = jest.spyOn(logger, 'warn').mockReturnValue(logger)
      mockFetchTrendSnapshots.mockResolvedValue([])
      mockComputeTrendViewsLive.mockResolvedValue([])

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm, fastLlm)

      expect(responses).toHaveLength(1)
      expect(responses[0].responseKind).toBeUndefined()
      expect(responses[0].message).toMatch(/don't have any past events|build(ing)? a trend/i)
      expect(mockBuildTrend).not.toHaveBeenCalled()
      // A genuinely empty topic is not a cold-store fault, so it must not warn.
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/backfill/i))
      warnSpy.mockRestore()
    })

    it('degrades to a single-event recap when only one event is available to compare', async () => {
      mockFetchTrendSnapshots.mockResolvedValue([])
      mockComputeTrendViewsLive.mockResolvedValue([{ conversationId: 'c1' }])
      mockResolvedConversation(false)
      const singleCard = { header: 'Recap', standouts: [] }
      mockBuildSummary.mockResolvedValue({ renderData: singleCard, metrics: {} })

      const responses = await handleSummon(buildContext(), trendMessage, fakeLlm, fastLlm)

      // One event is not a trend, so it recaps that event through the normal pipeline.
      expect(mockBuildTrend).not.toHaveBeenCalled()
      expect(mockBuildSummary).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }), fakeLlm, fastLlm)
      expect(responses[0].renderData).toBe(singleCard)
    })
  })

  describe('named-subset trend queries', () => {
    // A host can also compare a specific set of named events rather than a topic or "the last
    // N", e.g. "compare the Spring Town Hall to the AI Ethics kickoff". eventNames drives this
    // path instead of resolveTrendScope/trendEventCount.
    const namedTrendMessage = {
      _id: 'summon-msg',
      body: '@Vibes compare the Spring Town Hall to the AI Ethics kickoff'
    }
    const eventA = { id: 'a1', name: 'Spring Town Hall', topicName: 'Town Halls', endTime: new Date('2026-06-01') }
    const eventB = { id: 'a2', name: 'AI Ethics Kickoff', topicName: 'AI Ethics', endTime: new Date('2026-06-05') }

    beforeEach(() => {
      mockExtract.mockResolvedValue({
        eventQuery: '',
        latestInTopic: false,
        trend: true,
        eventCount: null,
        eventNames: ['Spring Town Hall', 'AI Ethics kickoff']
      })
    })

    it('resolves the named events instead of the recent-N scope', async () => {
      mockResolveNamedTrendScope.mockReturnValue({ resolved: [eventA, eventB], unresolved: [] })
      mockFetchTrendSnapshots.mockResolvedValue([{ conversationId: 'a2' }, { conversationId: 'a1' }])
      mockBuildTrend.mockResolvedValue({ header: 'Engagement across 2 events', standouts: [] })

      const responses = await handleSummon(buildContext(), namedTrendMessage, fakeLlm, fastLlm)

      expect(mockResolveNamedTrendScope).toHaveBeenCalledWith(['Spring Town Hall', 'AI Ethics kickoff'], [])
      expect(mockResolveTrendScope).not.toHaveBeenCalled()
      expect(mockTrendEventCount).not.toHaveBeenCalled()
      expect(mockFetchTrendSnapshots).toHaveBeenCalledWith([eventA, eventB], 2)
      expect(responses[0].renderData).toEqual({ header: 'Engagement across 2 events', standouts: [] })
    })

    it('notes any named event that did not resolve, alongside the trend card', async () => {
      mockResolveNamedTrendScope.mockReturnValue({ resolved: [eventA, eventB], unresolved: ['Q3 Sync'] })
      mockFetchTrendSnapshots.mockResolvedValue([{ conversationId: 'a2' }, { conversationId: 'a1' }])
      mockBuildTrend.mockResolvedValue({ header: 'Engagement across 2 events', standouts: [] })

      const responses = await handleSummon(buildContext(), namedTrendMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toMatch(/couldn't find.*"Q3 Sync"/i)
      expect(responses[0].renderData).toEqual({ header: 'Engagement across 2 events', standouts: [] })
    })

    it('says nothing matched, listing recent events, when every named event fails to resolve', async () => {
      mockFindCandidates.mockResolvedValue([eventA, eventB])
      mockResolveNamedTrendScope.mockReturnValue({ resolved: [], unresolved: ['Q3 Sync', 'The Gala'] })

      const responses = await handleSummon(buildContext(), namedTrendMessage, fakeLlm, fastLlm)

      expect(responses).toHaveLength(1)
      expect(responses[0].responseKind).toBeUndefined()
      expect(responses[0].message).toBe(namedTrendNotFoundMessage(['Q3 Sync', 'The Gala'], [eventB, eventA] as never))
      expect(mockFetchTrendSnapshots).not.toHaveBeenCalled()
      expect(mockBuildTrend).not.toHaveBeenCalled()
    })

    it('notes the unresolved name when the trend degrades to a single-event recap', async () => {
      mockResolveNamedTrendScope.mockReturnValue({ resolved: [eventA], unresolved: ['Q3 Sync'] })
      mockFetchTrendSnapshots.mockResolvedValue([])
      mockComputeTrendViewsLive.mockResolvedValue([{ conversationId: 'a1' }])
      mockResolvedConversation(false)
      mockBuildSummary.mockResolvedValue({ renderData: { header: 'Recap', standouts: [] }, metrics: {} })

      const responses = await handleSummon(buildContext(), namedTrendMessage, fakeLlm, fastLlm)

      expect(mockBuildTrend).not.toHaveBeenCalled()
      expect(responses[0].message).toMatch(/couldn't find.*"Q3 Sync"/i)
    })
  })

  describe('question intent', () => {
    // A "question" intent asks something specific about one event rather than a general recap.
    // handleQuestionSummon resolves the event the same way a recap does, then branches on scope.
    const questionMessage = { _id: 'q-msg', body: '@Vibes how many people came to the Spring Town Hall?' }

    it('answers a quantitative question live, without requiring a threaded reply under a prior card', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'quantitative',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(false)
      mockComputeConversationMetrics.mockResolvedValue({ participation: { posterCount: 40 } })
      mockBuildSnapshotPayload.mockReturnValue({ posterCount: 40 })
      mockAnswerFollowUp.mockResolvedValue({ answerable: true, text: '40 people posted.' })

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(mockComputeConversationMetrics).toHaveBeenCalledWith(expect.objectContaining({ _id: 'c1' }))
      expect(mockAnswerFollowUp).toHaveBeenCalledWith(questionMessage.body, [{ posterCount: 40 }], fakeLlm)
      expect(responses).toHaveLength(1)
      expect(responses[0].message).toBe('40 people posted.')
      expect(responses[0].responseKind).toBeUndefined()
      expect(mockBuildSummary).not.toHaveBeenCalled()
    })

    it('defers an interpretive question to the Event Historian when one is installed, without computing metrics', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'interpretive',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(false)
      mockHasHistorianAgent.mockResolvedValue(true)

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(mockComputeConversationMetrics).not.toHaveBeenCalled()
      expect(mockAnswerFollowUp).not.toHaveBeenCalled()
      expect(responses[0].message).toMatch(/Event Historian/)
    })

    it('gives an honest refusal for an interpretive question when no Event Historian is installed', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'interpretive',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(false)
      mockHasHistorianAgent.mockResolvedValue(false)

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].message).not.toMatch(/Event Historian can help/)
      expect(responses[0].message).toMatch(/add one here, or ask in a channel/)
    })

    it('answers the quantitative half of a mixed question and points the rest to the historian', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'mixed',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(false)
      mockHasHistorianAgent.mockResolvedValue(true)
      mockAnswerFollowUp.mockResolvedValue({ answerable: true, text: '40 people posted.' })

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toBe(
        '40 people posted. For what was actually said, the Event Historian can help with the rest.'
      )
    })

    it('answers the quantitative half of a mixed question and suggests adding a historian when none is installed', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'mixed',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(false)
      mockHasHistorianAgent.mockResolvedValue(false)
      mockAnswerFollowUp.mockResolvedValue({ answerable: true, text: '40 people posted.' })

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toBe(
        "40 people posted. For what was actually said, that's a question for the Event Historian: there's none in this channel, so add one here or ask in a channel that already has one."
      )
    })

    it('falls back to a not-found reply when the question names no matching public event', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'quantitative',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'notFound' })

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toBe(notFoundMessage('Spring Town Hall', []))
      expect(mockComputeConversationMetrics).not.toHaveBeenCalled()
    })

    it('asks which event when a question matches more than one public event', async () => {
      const candidates = [
        { id: '1', name: 'Spring Town Hall' },
        { id: '2', name: 'Fall Town Hall' }
      ]
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'quantitative',
        eventQuery: 'Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'ambiguous', candidates })

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].responseKind).toBe('eventDisambiguation')
      expect(mockComputeConversationMetrics).not.toHaveBeenCalled()
    })

    it('guides instead of resolving when a question names no event at all', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'quantitative',
        eventQuery: '   ',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })

      const responses = await handleSummon(
        buildContext(),
        { _id: 'm', body: '@Vibes how many people came?' },
        fakeLlm,
        fastLlm
      )

      expect(responses[0].message).toBe(helpMessage([]))
      expect(mockResolve).not.toHaveBeenCalled()
    })

    it('refuses and never computes metrics when the resolved event is on a private topic', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'quantitative',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(true) // private topic

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toContain('can only recap public events')
      expect(mockComputeConversationMetrics).not.toHaveBeenCalled()
    })

    it('falls back to an unanswerable-question reply when neither pass can answer it', async () => {
      mockExtract.mockResolvedValue({
        intent: 'question',
        scope: 'quantitative',
        eventQuery: 'Spring Town Hall',
        latestInTopic: false,
        latestOverall: false,
        trend: false
      })
      mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
      mockResolvedConversation(false)
      mockAnswerFollowUp.mockResolvedValue({ answerable: false, text: null })
      mockAnswerWithOnDemandMetrics.mockResolvedValue(null)

      const responses = await handleSummon(buildContext(), questionMessage, fakeLlm, fastLlm)

      expect(responses[0].message).toBe(unanswerableQuestionMessage('Spring Town Hall'))
    })

    describe('escalating to an on-demand computation', () => {
      const openEndedQuestion = { _id: 'q-msg', body: '@Vibes how many people posted more than three times?' }

      function mockOpenEndedQuestion(scope = 'quantitative') {
        mockExtract.mockResolvedValue({
          intent: 'question',
          scope,
          eventQuery: 'Spring Town Hall',
          latestInTopic: false,
          latestOverall: false,
          trend: false
        })
        mockResolve.mockReturnValue({ status: 'resolved', event: { id: 'c1', name: 'Spring Town Hall' } })
        mockResolvedConversation(false)
      }

      it('computes a new metric over the event when the precomputed numbers cannot answer', async () => {
        mockOpenEndedQuestion()
        mockComputeConversationMetrics.mockResolvedValue({ participation: { posterCount: 40 } })
        mockAnswerFollowUp.mockResolvedValue({ answerable: false, text: null })
        mockAnswerWithOnDemandMetrics.mockResolvedValue('7 people posted more than three times.')

        const responses = await handleSummon(buildContext(), openEndedQuestion, fakeLlm, fastLlm)

        // The live metrics go along, so the loop only reaches for a tool when they fall short.
        expect(mockAnswerWithOnDemandMetrics).toHaveBeenCalledWith(
          openEndedQuestion.body,
          expect.objectContaining({ _id: 'c1' }),
          { participation: { posterCount: 40 } },
          fakeLlm
        )
        expect(responses[0].message).toBe('7 people posted more than three times.')
      })

      it('never runs the tool loop when the precomputed numbers already answer the question', async () => {
        mockOpenEndedQuestion()
        mockAnswerFollowUp.mockResolvedValue({ answerable: true, text: '40 people posted.' })

        const responses = await handleSummon(buildContext(), openEndedQuestion, fakeLlm, fastLlm)

        expect(mockAnswerWithOnDemandMetrics).not.toHaveBeenCalled()
        expect(responses[0].message).toBe('40 people posted.')
      })

      it('points the interpretive half of a mixed question to the historian after computing the rest', async () => {
        mockOpenEndedQuestion('mixed')
        mockHasHistorianAgent.mockResolvedValue(true)
        mockAnswerFollowUp.mockResolvedValue({ answerable: false, text: null })
        mockAnswerWithOnDemandMetrics.mockResolvedValue('7 people posted more than three times.')

        const responses = await handleSummon(buildContext(), openEndedQuestion, fakeLlm, fastLlm)

        expect(responses[0].message).toBe(
          '7 people posted more than three times. For what was actually said, the Event Historian can help with the rest.'
        )
      })

      it('never computes anything for an interpretive question', async () => {
        mockOpenEndedQuestion('interpretive')

        await handleSummon(buildContext(), openEndedQuestion, fakeLlm, fastLlm)

        expect(mockAnswerWithOnDemandMetrics).not.toHaveBeenCalled()
      })
    })
  })
})
