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
    // Matches the cap the Vibes Analyst agent runs its main-model passes with. Without it the
    // model defaults to 1024 tokens, which cuts the longest answers off mid-response.
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel, { maxTokens: 10000 })
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

/* A concentrated, threaded event whose new-metric numbers make clean ratios, so the
   critic can check comparative and multiplier claims against exact figures. Of 100
   messages the busiest three posters sent 75 (topPosterMessageShare 0.75), leaving 25
   for the other 17, an exact 3x split. One-time posters (15) outnumber repeat posters
   (5) three to one. The first private message took six times as long to land as the
   first public one (120s vs 20s). */
function concentratedEventMetrics(): ConversationMetrics {
  return makeMetrics({
    participation: { posterCount: 20, frequentPosterCount: 2, frequentPosterMessageShare: 0.5, messageCount: 100 },
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
      topPosterMessageShare: 0.75,
      oneTimePosterCount: 15,
      repeatPosterCount: 5
    },
    timeToFirstMessage: { publicSeconds: 20, privateSeconds: 120 },
    replyLatency: { medianSecondsToFirstReply: 30, repliedMessageCount: 40 },
    interactionStructure: { threadCount: 8, maxThreadSize: 12, medianThreadSize: 3, maxReplyDepth: 5 },
    spikes: [],
    participationHistory: [{ label: 'Today', posterCount: 20, lurkerCount: null }],
    baseline: null,
    channelSplit: { public: 80, private: 20 },
    privateMessaging: {
      privateMessageCount: 20,
      distinctPrivateSenders: 4,
      distinctPublicSenders: 20,
      avgPrivateMessagesPerPoster: 1
    },
    botInvocations: { botName: 'Berkie', count: 0 },
    receptions: [],
    resourceSummary: { total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 },
    eventPlatform: 'nextspace'
  })
}

describe('verifyCuratedCard critic over the interpretation-layer metrics', () => {
  let llm

  beforeAll(async () => {
    const llmPlatform = process.env.TEST_LLM_PLATFORM || supportedModels[0].llmPlatform
    const llmModel = process.env.TEST_LLM_MODEL || supportedModels[0].llmModel
    // Matches the cap the Vibes Analyst agent runs its main-model passes with. Without it the
    // model defaults to 1024 tokens, which cuts the longest answers off mid-response.
    llm = await getModelChat(llmPlatform as LlmPlatforms, llmModel, { maxTokens: 10000 })
  })

  it('keeps a comparative read over the new metrics that the exact figures back', async () => {
    const card: CuratedVibesData = {
      header: 'A tight core carried the room',
      standouts: [
        // topPosterMessageShare 0.75 = the busiest three wrote most of the 100 messages;
        // replyLatency median 30s reads as fast. Both are exact first-party numbers.
        {
          text: '*A tight, active core.* The three busiest posters wrote most of the messages, and replies came fast, a median of 30 seconds to the first reply.'
        }
      ],
      durationMinutes: 45
    }

    const result = await verifyCuratedCard(card, concentratedEventMetrics(), llm)

    expect(result.standouts).toHaveLength(1)
  })

  it('keeps a multiplier claim whose ratio matches the figures', async () => {
    const card: CuratedVibesData = {
      header: 'Talkers and drive-bys',
      standouts: [
        // topPosterMessageShare 0.75 means the top three wrote 75% of messages and the rest 25%, a 3x split.
        {
          text: '*The busiest few dominated.* The three most active posters wrote about three times as many messages as everyone else combined.'
        }
      ],
      durationMinutes: 45
    }

    const result = await verifyCuratedCard(card, concentratedEventMetrics(), llm)

    expect(result.standouts).toHaveLength(1)
  })

  it('drops a multiplier claim whose ratio the figures contradict', async () => {
    const card: CuratedVibesData = {
      header: 'Talkers and drive-bys',
      standouts: [
        // The real split is 75 vs 25 (3x). Claiming ten times overstates it well past rounding.
        {
          text: '*The busiest few dominated.* The three most active posters wrote ten times as many messages as everyone else combined.'
        }
      ],
      durationMinutes: 45
    }

    const result = await verifyCuratedCard(card, concentratedEventMetrics(), llm)

    expect(result.standouts).toHaveLength(0)
  })
})
