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
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
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

  it('adds a data-availability note when no tracked sessions were captured', async () => {
    const metrics = negativeEventMetrics()
    metrics.trackedSessionSources = []
    metrics.trackedSessionStatus = 'notTracked'

    const card = await curateVibesCard(metrics, { eventName: 'The Future of Work', durationMinutes: 52 }, llm)

    expect(typeof card.availabilityNote).toBe('string')
    expect(card.availabilityNote!.length).toBeGreaterThan(0)
  })
})
