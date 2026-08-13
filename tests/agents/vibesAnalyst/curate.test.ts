import curateVibesCard from '../../../src/agents/vibesAnalyst/curate.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { ConversationMetrics, LlmPlatforms } from '../../../src/types/index.types.js'
import makeMetrics from '../../utils/metricsFixture.js'

jest.setTimeout(45000) // LLM calls can be slow

const CHART_TYPES = ['bar', 'line', 'area', 'pie']

/* A data-rich, clearly-down event so the model has several real things it could
   choose to feature (participation below the topic's norm, late drop-off in
   activity, a private-heavy channel split, and tracked sessions to draw on). */
function negativeEventMetrics(): ConversationMetrics {
  return makeMetrics({
    participation: { posterCount: 17, frequentPosterCount: 2, frequentPosterMessageShare: 0.5, messageCount: 64 },
    trackedSessionSources: [
      {
        source: 'matomo',
        capturedAt: new Date('2026-06-10T11:00:00.000Z'),
        trackedSessions: 100,
        attendeeCount: 40,
        avgDwellSeconds: 1140,
        totalActions: 800,
        deviceBreakdown: { desktop: 70, mobile: 30 },
        actionBreakdown: { 'command:visual': 30, 'tab:resources': 22, 'transcript:open': 12 },
        actionUserBreakdown: { 'command:visual': 18, 'tab:resources': 15, 'transcript:open': 10 },
        activeVisitorCount: 38,
        actionBreakdownPerActiveVisitor: { 'command:visual': 30 / 38, 'tab:resources': 22 / 38, 'transcript:open': 12 / 38 }
      }
    ],
    trackedSessionStatus: 'available',
    audienceEngagement: {
      participantCount: 40,
      lurkerCount: 23,
      participationRate: 0.425,
      postersExceedTrackedSessions: false
    },
    activitySeries: [
      { label: '0-10', messageCount: 6 },
      { label: '10-20', messageCount: 18 },
      { label: '20-30', messageCount: 12 },
      { label: '30-40', messageCount: 9 },
      { label: '40-50', messageCount: 6 },
      { label: '50-58', messageCount: 4 }
    ],
    spikes: [],
    participationHistory: [
      { label: 'E1', posterCount: 29, lurkerCount: 60 },
      { label: 'E2', posterCount: 30, lurkerCount: 58 },
      { label: 'E3', posterCount: 35, lurkerCount: 70 },
      { label: 'E4', posterCount: 28, lurkerCount: 55 },
      { label: 'E5', posterCount: 27, lurkerCount: 52 },
      { label: 'Today', posterCount: 17, lurkerCount: 23 }
    ],
    baseline: { eventCount: 5, trackedEventCount: 5, avgPosterCount: 29.8, avgLurkerCount: 59, avgDwellSeconds: 1440 },
    channelSplit: { public: 26, private: 38 },
    privateMessaging: {
      privateMessageCount: 38,
      distinctPrivateSenders: 9,
      distinctPublicSenders: 14,
      avgPrivateMessagesPerPoster: 38 / 17
    },
    botInvocations: { botName: 'Berkie', count: 4 },
    receptions: [
      {
        sparkQuote: 'remote work is here to stay',
        reactionVolume: 9,
        reactionQuote: 'finally someone said it out loud',
        sentiment: 'agreement'
      }
    ],
    resourceSummary: { total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 },
    eventPlatform: 'nextspace'
  })
}

describe('curateVibesCard', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    // Matches the cap the Vibes Analyst agent runs with. Without it the model defaults to 1024
    // tokens, which cuts the longest cards off mid-response.
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel, { maxTokens: 10000 })
  })

  it('writes a header and 2 to 3 standouts, only attaching well-formed charts', async () => {
    const card = await curateVibesCard(negativeEventMetrics(), { eventName: 'The Future of Work', durationMinutes: 58 }, llm)

    expect(typeof card.header).toBe('string')
    expect(card.header.length).toBeGreaterThan(0)
    expect(card.durationMinutes).toBe(58)
    expect(card.standouts.length).toBeGreaterThanOrEqual(2)
    expect(card.standouts.length).toBeLessThanOrEqual(3)

    for (const standout of card.standouts) {
      expect(typeof standout.text).toBe('string')
      expect(standout.text.length).toBeGreaterThan(0)
      if (standout.visual) {
        expect(standout.visual.title.length).toBeGreaterThan(0)
        expect(CHART_TYPES).toContain(standout.visual.chart.type)
      }
    }

    // Tracked-session data is present, so there is no "data is limited" note.
    expect(card.availabilityNote).toBeUndefined()
  })

  it('surfaces the concentration signal when a tiny core dominates a room of one-time posters', async () => {
    // Everything else is neutral (no spikes, receptions, tracked sessions, or baseline swing),
    // so the concentrated posting is the one thing worth surfacing: of 30 posters, 27 posted
    // once and 3 wrote 85% of the messages.
    const metrics = makeMetrics({
      participation: { posterCount: 30, frequentPosterCount: 3, frequentPosterMessageShare: 0.85, messageCount: 120 },
      trackedSessionSources: [],
      trackedSessionStatus: 'notTracked',
      audienceEngagement: {
        participantCount: 0,
        lurkerCount: null,
        participationRate: null,
        postersExceedTrackedSessions: true
      },
      participationConcentration: {
        topPosterCount: 3,
        topPosterMessageShare: 0.85,
        oneTimePosterCount: 27,
        repeatPosterCount: 3
      },
      spikes: [],
      receptions: [],
      participationHistory: [{ label: 'Today', posterCount: 30, lurkerCount: null }],
      baseline: null,
      channelSplit: { public: 110, private: 10 }
    })

    const card = await curateVibesCard(metrics, { eventName: 'Open Forum', durationMinutes: 40 }, llm)

    expect(card.standouts.length).toBeGreaterThanOrEqual(2)
    const allText = card.standouts
      .map((standout) => standout.text)
      .join(' ')
      .toLowerCase()
    expect(allText).toMatch(/once|one-time|one time|single|drive-by|core|few|handful|85|concentrat|dominat|most of the/)
  })

  it('surfaces a peer comparison when this event ran well above similar-sized public events', async () => {
    // Everything else is neutral (no spikes, receptions, tracked sessions, or same-topic
    // baseline), so the peer comparison is the one thing worth surfacing: 40 posters against
    // a peer average of 16 for similarly sized public events on the same platform.
    const metrics = makeMetrics({
      participation: { posterCount: 40, frequentPosterCount: 4, frequentPosterMessageShare: 0.3, messageCount: 150 },
      trackedSessionSources: [],
      trackedSessionStatus: 'notTracked',
      audienceEngagement: {
        participantCount: 0,
        lurkerCount: null,
        participationRate: null,
        postersExceedTrackedSessions: true
      },
      spikes: [],
      receptions: [],
      participationHistory: [{ label: 'Today', posterCount: 40, lurkerCount: null }],
      baseline: null,
      peerBaseline: {
        band: 'medium',
        eventCount: 6,
        avgPosterCount: 16,
        avgParticipationRate: null,
        participationRateEventCount: 0,
        avgTopPosterMessageShare: null,
        concentrationEventCount: 0
      },
      channelSplit: { public: 140, private: 10 }
    })

    const card = await curateVibesCard(metrics, { eventName: 'Open Forum', durationMinutes: 45 }, llm)

    expect(card.standouts.length).toBeGreaterThanOrEqual(2)
    const allText = card.standouts
      .map((standout) => standout.text)
      .join(' ')
      .toLowerCase()
    expect(allText).toMatch(/similar|peer|typical|other events|events this size|16/)
  })

  it('leads with the ranked deviation when a tracked-session figure swung far from the topic norm', async () => {
    // Poster count and lurkers are both close to their recent norm (no story there), but average
    // dwell time nearly tripled versus the topic's baseline. topDeviations names that as the one
    // outlier, so it should be the standout even though nothing else in the fixture stands out.
    const metrics = makeMetrics({
      participation: { posterCount: 21, frequentPosterCount: 2, frequentPosterMessageShare: 0.3, messageCount: 60 },
      trackedSessionSources: [
        {
          source: 'matomo',
          capturedAt: new Date('2026-06-10T18:05:00.000Z'),
          trackedSessions: 25,
          attendeeCount: 21,
          avgDwellSeconds: 900,
          totalActions: 100,
          deviceBreakdown: {},
          actionBreakdown: {},
          actionUserBreakdown: {},
          activeVisitorCount: 0,
          actionBreakdownPerActiveVisitor: {}
        }
      ],
      trackedSessionStatus: 'available',
      audienceEngagement: {
        participantCount: 25,
        lurkerCount: 4,
        participationRate: 0.84,
        postersExceedTrackedSessions: false
      },
      spikes: [],
      receptions: [],
      participationHistory: [
        { label: 'E1', posterCount: 20, lurkerCount: 4 },
        { label: 'Today', posterCount: 21, lurkerCount: 4 }
      ],
      baseline: { eventCount: 4, trackedEventCount: 4, avgPosterCount: 20, avgLurkerCount: 4, avgDwellSeconds: 310 },
      peerBaseline: null,
      topDeviations: [
        {
          metric: 'avgDwellSeconds',
          comparison: 'topicBaseline',
          tier: 'estimate',
          value: 900,
          comparedTo: 310,
          percentDifference: (900 - 310) / 310,
          direction: 'above'
        }
      ],
      channelSplit: { public: 55, private: 5 }
    })

    const card = await curateVibesCard(metrics, { eventName: 'Deep Dive Session', durationMinutes: 60 }, llm)

    expect(card.standouts.length).toBeGreaterThanOrEqual(2)
    const allText = card.standouts
      .map((standout) => standout.text)
      .join(' ')
      .toLowerCase()
    // The model may humanize 900 seconds to "15 minutes" and word dwell as engagement/attention,
    // so accept the natural phrasings, not just the literal metric name or raw seconds.
    expect(allText).toMatch(
      /dwell|session length|time spent|900|minutes per|per tracked session|per visit|engagement|stayed|attention/
    )
    expect(allText).toMatch(/undercount/)
  })

  it('uses speaker count and active agent labels as light framing context, not a standout', async () => {
    const card = await curateVibesCard(
      negativeEventMetrics(),
      {
        eventName: 'The Future of Work',
        durationMinutes: 58,
        speakerCount: 3,
        activeAgentTypeLabels: ['a jargon filter']
      },
      llm
    )

    // The scene-setting facts may appear in the framing line, but never as one of the
    // 2 to 3 headline standouts: the participation and activity numbers are what stood out
    // in this fixture, not who spoke or which other assistants ran.
    const standoutText = card.standouts
      .map((standout) => standout.text)
      .join(' ')
      .toLowerCase()
    expect(standoutText).not.toMatch(/jargon filter/)
  })

  it('adds a data-availability note when no tracked sessions were captured', async () => {
    const metrics = negativeEventMetrics()
    metrics.trackedSessionSources = []
    metrics.trackedSessionStatus = 'notTracked'

    const card = await curateVibesCard(metrics, { eventName: 'The Future of Work', durationMinutes: 52 }, llm)

    expect(typeof card.availabilityNote).toBe('string')
    expect(card.availabilityNote!.length).toBeGreaterThan(0)
  })
})
