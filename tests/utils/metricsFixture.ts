import { ConversationMetrics } from '../../src/types/index.types.js'

/* A complete, neutral ConversationMetrics for unit tests: a modest positive event with no tracked
   sessions. Pass overrides to set only the fields a test cares about; every other field, including
   any metric added later, comes from this default, so a new metric is one change here instead of one
   per fixture. Overrides shallow-merge at the top level, so a sub-object override (e.g.
   audienceEngagement) replaces that whole sub-object, matching how these fixtures were written. */
export default function makeMetrics(overrides: Partial<ConversationMetrics> = {}): ConversationMetrics {
  return {
    participation: { posterCount: 20, frequentPosterCount: 2, frequentPosterMessageShare: 0.4, messageCount: 50 },
    trackedSessionSources: [],
    trackedSessionStatus: 'notTracked',
    audienceEngagement: {
      participantCount: 0,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    },
    activitySeries: [
      { label: '0-10', messageCount: 5 },
      { label: '10-20', messageCount: 15 }
    ],
    spikes: [],
    participationHistory: [
      { label: 'E1', posterCount: 18, lurkerCount: null },
      { label: 'Today', posterCount: 20, lurkerCount: null }
    ],
    baseline: { eventCount: 3, trackedEventCount: 0, avgPosterCount: 18, avgLurkerCount: null, avgDwellSeconds: null },
    channelSplit: { public: 30, private: 20 },
    timeToFirstMessage: { publicSeconds: null, privateSeconds: null },
    replyLatency: { medianSecondsToFirstReply: null, repliedMessageCount: 0 },
    participationConcentration: {
      topPosterCount: 3,
      topPosterMessageShare: 0.3,
      oneTimePosterCount: 12,
      repeatPosterCount: 8
    },
    privateMessaging: {
      privateMessageCount: 20,
      distinctPrivateSenders: 6,
      distinctPublicSenders: 18,
      avgPrivateMessagesPerPoster: 1
    },
    botInvocations: { botName: 'Berkie', count: 0 },
    receptions: [],
    resourceSummary: { total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 },
    eventPlatform: 'nextspace',
    ...overrides
  }
}
