import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { EventMetricsSnapshot } from '../../../src/models/index.js'
import eventMetricsSnapshotService, { buildSnapshotPayload } from '../../../src/services/eventMetricsSnapshot.service.js'
import { METRICS_VERSION } from '../../../src/services/conversationAnalytics.service.js'
import { ConversationMetrics } from '../../../src/types/index.types.js'

setupIntTest()

/* A fully populated ConversationMetrics bundle, the shape buildVibesSummary hands the
   persistence service after enrichment. The spikes and receptions carry verbatim quote text
   on purpose, so the test can prove the snapshot keeps the counts and drops the words. */
function sampleMetrics(): ConversationMetrics {
  return {
    participation: { posterCount: 12, frequentPosterCount: 2, frequentPosterMessageShare: 0.45, messageCount: 140 },
    trackedSessionSources: [
      {
        source: 'matomo',
        capturedAt: new Date('2026-06-10T18:05:00.000Z'),
        trackedSessions: 90,
        attendeeCount: 80,
        avgDwellSeconds: 420,
        totalActions: 950,
        deviceBreakdown: { desktop: 60, mobile: 30 }
      }
    ],
    trackedSessionStatus: 'available',
    audienceEngagement: {
      participantCount: 80,
      lurkerCount: 68,
      participationRate: 0.15,
      postersExceedTrackedSessions: false
    },
    activitySeries: [{ label: '0-9', messageCount: 40 }],
    spikes: [
      {
        label: '10-19',
        startMinute: 10,
        endMinute: 19,
        messageCount: 30,
        baselineAverage: 10,
        ratio: 3,
        source: 'chat',
        annotation: { topic: 'pricing', quote: 'this is a verbatim chat quote' }
      },
      {
        label: '20-29',
        startMinute: 20,
        endMinute: 29,
        messageCount: 25,
        baselineAverage: 10,
        ratio: 2.5,
        source: 'moderator'
      }
    ],
    participationHistory: [{ label: 'Today', posterCount: 12, lurkerCount: 68 }],
    baseline: null,
    channelSplit: { public: 130, private: 10 },
    botInvocations: { botName: 'Berkie', count: 7 },
    receptions: [
      {
        sparkQuote: 'a verbatim speaker line',
        reactionVolume: 8,
        reactionQuote: 'a verbatim reply',
        sentiment: 'agreement'
      },
      { sparkQuote: 'another line', reactionVolume: 5, reactionQuote: 'another reply', sentiment: 'mixed' },
      { sparkQuote: 'a third line', reactionVolume: 4, reactionQuote: 'a third reply', sentiment: 'pushback' }
    ],
    resourceSummary: { total: 4, required: 2, referenced: 1, suggested: 1, withLinks: 3 },
    eventPlatform: 'nextspace'
  }
}

function sampleConversation(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    topic: { _id: new mongoose.Types.ObjectId() },
    name: 'Future of Work',
    endTime: new Date('2026-06-10T18:00:00.000Z'),
    experimental: false,
    ...overrides
  }
}

describe('eventMetricsSnapshot.service', () => {
  describe('buildSnapshotPayload', () => {
    it('maps the scalar metrics and drops every verbatim quote', () => {
      const conversation = sampleConversation()
      const payload = buildSnapshotPayload(conversation, sampleMetrics())

      expect(payload.conversationId).toBe(conversation._id)
      expect(payload.topicId).toBe(conversation.topic._id)
      expect(payload.eventName).toBe('Future of Work')
      expect(payload.eventEndTime).toEqual(new Date('2026-06-10T18:00:00.000Z'))
      expect(payload.eventPlatform).toBe('nextspace')
      expect(payload.metricsVersion).toBe(METRICS_VERSION)

      expect(payload.posterCount).toBe(12)
      expect(payload.messageCount).toBe(140)
      expect(payload.frequentPosterCount).toBe(2)
      expect(payload.frequentPosterMessageShare).toBe(0.45)

      expect(payload.trackedSessionStatus).toBe('available')
      expect(payload.trackedSessions).toBe(90)
      expect(payload.participantCount).toBe(80)
      expect(payload.lurkerCount).toBe(68)
      expect(payload.participationRate).toBe(0.15)
      expect(payload.postersExceedTrackedSessions).toBe(false)
      expect(payload.avgDwellSeconds).toBe(420)
      expect(payload.totalActions).toBe(950)

      expect(payload.channelSplit).toEqual({ public: 130, private: 10 })
      expect(payload.botInvocationCount).toBe(7)
      expect(payload.resourceSummary).toEqual({ total: 4, required: 2, referenced: 1, suggested: 1, withLinks: 3 })

      // Counts kept, quotes dropped: the payload carries lengths, never the text.
      expect(payload.spikeCount).toBe(2)
      expect(payload.receptionCount).toBe(3)
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain('verbatim')
      expect(serialized).not.toContain('pricing')
    })

    it('records null tracked-session estimates when there is no analytics data', () => {
      const metrics = sampleMetrics()
      metrics.trackedSessionSources = []
      metrics.trackedSessionStatus = 'notTracked'
      metrics.audienceEngagement = null

      const payload = buildSnapshotPayload(sampleConversation(), metrics)
      expect(payload.participantCount).toBeNull()
      expect(payload.lurkerCount).toBeNull()
      expect(payload.participationRate).toBeNull()
      expect(payload.postersExceedTrackedSessions).toBeNull()
      expect(payload.avgDwellSeconds).toBeNull()
      expect(payload.totalActions).toBeNull()
      expect(payload.trackedSessions).toBe(0)
    })

    it('honours a reception-count override so a scalar-only recompute can record null', () => {
      const payload = buildSnapshotPayload(sampleConversation(), sampleMetrics(), { receptionCount: null })
      expect(payload.receptionCount).toBeNull()
    })

    it('resolves the topic id whether topic is populated or a raw id', () => {
      const topicId = new mongoose.Types.ObjectId()
      const payload = buildSnapshotPayload(sampleConversation({ topic: topicId }), sampleMetrics())
      expect(payload.topicId).toBe(topicId)
    })
  })

  describe('persistSnapshot', () => {
    it('writes one snapshot for an ended event', async () => {
      const conversation = sampleConversation()
      await eventMetricsSnapshotService.persistSnapshot(conversation, sampleMetrics())

      const stored = await EventMetricsSnapshot.find({ conversationId: conversation._id })
      expect(stored).toHaveLength(1)
      expect(stored[0].posterCount).toBe(12)
      expect(stored[0].spikeCount).toBe(2)
      expect(stored[0].receptionCount).toBe(3)
    })

    it('upserts on a re-run rather than duplicating', async () => {
      const conversation = sampleConversation()
      await eventMetricsSnapshotService.persistSnapshot(conversation, sampleMetrics())

      const updated = sampleMetrics()
      updated.participation.posterCount = 20
      await eventMetricsSnapshotService.persistSnapshot(conversation, updated)

      const stored = await EventMetricsSnapshot.find({ conversationId: conversation._id })
      expect(stored).toHaveLength(1)
      expect(stored[0].posterCount).toBe(20)
    })

    it('skips experimental conversations', async () => {
      const conversation = sampleConversation({ experimental: true })
      const result = await eventMetricsSnapshotService.persistSnapshot(conversation, sampleMetrics())

      expect(result).toBeNull()
      const stored = await EventMetricsSnapshot.find({ conversationId: conversation._id })
      expect(stored).toHaveLength(0)
    })
  })
})
