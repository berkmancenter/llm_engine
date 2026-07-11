import verifyCuratedCard from '../../../src/agents/vibesAnalyst/verifyCuration.js'
import { getModelChat, supportedModels } from '../../../src/agents/helpers/getModelChat.js'
import { ConversationMetrics, CuratedVibesData, LlmPlatforms } from '../../../src/types/index.types.js'
import makeMetrics from '../../utils/metricsFixture.js'

jest.setTimeout(45000) // LLM calls can be slow

/* A clearly-down event: far fewer people posted today (16) than the topic's recent
   average (about 30 posters), activity tails off, and there are no tracked sessions.
   The critic should be able to confirm or refute claims against these exact numbers. */
function metricsFixture(): ConversationMetrics {
  return makeMetrics({
    participation: { posterCount: 16, frequentPosterCount: 2, frequentPosterMessageShare: 0.5, messageCount: 60 },
    trackedSessionSources: [],
    trackedSessionStatus: 'notTracked',
    audienceEngagement: {
      participantCount: 0,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    },
    activitySeries: [
      { label: '0-10', messageCount: 20 },
      { label: '10-20', messageCount: 18 },
      { label: '20-30', messageCount: 12 },
      { label: '30-40', messageCount: 6 },
      { label: '40-50', messageCount: 3 },
      { label: '50-58', messageCount: 1 }
    ],
    spikes: [],
    participationHistory: [
      { label: 'E1', posterCount: 30, lurkerCount: null },
      { label: 'E2', posterCount: 30, lurkerCount: null },
      { label: 'Today', posterCount: 16, lurkerCount: null }
    ],
    baseline: { eventCount: 2, trackedEventCount: 0, avgPosterCount: 30, avgLurkerCount: null, avgDwellSeconds: null },
    channelSplit: { public: 40, private: 20 },
    privateMessaging: {
      privateMessageCount: 20,
      distinctPrivateSenders: 5,
      distinctPublicSenders: 16,
      avgPrivateMessagesPerPoster: 20 / 16
    },
    botInvocations: { botName: 'Berkie', count: 0 },
    receptions: [
      {
        sparkQuote: 'we should ban gas stoves entirely',
        reactionVolume: 7,
        reactionQuote: 'no way, gas is better for cooking',
        sentiment: 'pushback'
      }
    ],
    resourceSummary: { total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 },
    eventPlatform: 'nextspace'
  })
}

describe('verifyCuratedCard critic', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel)
  })

  it('keeps standouts whose claims match the metrics', async () => {
    const card: CuratedVibesData = {
      header: 'Quiet turnout for the panel',
      standouts: [
        { text: 'Only 16 people posted today, well below the topic recent average of about 30.' },
        { text: 'Activity faded over the session, from 20 messages early to just 1 in the final stretch.' }
      ],
      durationMinutes: 58
    }

    const result = await verifyCuratedCard(card, metricsFixture(), llm)

    expect(result.standouts).toHaveLength(2)
  })

  it('drops a standout that claims a trend the metrics contradict', async () => {
    const card: CuratedVibesData = {
      header: 'Strong turnout for the panel',
      standouts: [
        { text: 'Only 16 people posted today, well below the topic recent average of about 30.' },
        // The numbers show posting falling to 16, so a "record high" claim is unsupported.
        { text: 'Posting surged to a record high today, the best this topic has ever seen.' }
      ],
      durationMinutes: 58
    }

    const result = await verifyCuratedCard(card, metricsFixture(), llm)

    const survivingText = result.standouts.map((standout) => standout.text)
    expect(survivingText).toContain('Only 16 people posted today, well below the topic recent average of about 30.')
    expect(survivingText).not.toContain('Posting surged to a record high today, the best this topic has ever seen.')
  })

  it('keeps a reception standout backed by a matching reception', async () => {
    const card: CuratedVibesData = {
      header: 'A divisive moment',
      standouts: [
        {
          text: 'When a speaker said "we should ban gas stoves entirely", the room pushed back, one reply being "no way, gas is better for cooking".'
        }
      ],
      durationMinutes: 58
    }

    const result = await verifyCuratedCard(card, metricsFixture(), llm)

    expect(result.standouts).toHaveLength(1)
  })

  it('drops a reception standout whose sentiment the metrics contradict', async () => {
    const card: CuratedVibesData = {
      header: 'A crowd-pleaser',
      standouts: [
        // The reception's sentiment is pushback, so claiming agreement is unsupported.
        { text: 'The room loved the call to "ban gas stoves entirely", cheering it on with near-universal agreement.' }
      ],
      durationMinutes: 58
    }

    const result = await verifyCuratedCard(card, metricsFixture(), llm)

    expect(result.standouts).toHaveLength(0)
  })
})
