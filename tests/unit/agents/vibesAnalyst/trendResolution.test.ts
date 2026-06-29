import mongoose from 'mongoose'
import setupIntTest from '../../../utils/setupIntTest.js'
import { EventMetricsSnapshot } from '../../../../src/models/index.js'
import { METRICS_VERSION } from '../../../../src/services/conversationAnalytics.service.js'
import {
  resolveTrendScope,
  trendEventCount,
  fetchTrendSnapshots,
  DEFAULT_TREND_EVENTS,
  EventCandidate
} from '../../../../src/agents/vibesAnalyst/eventResolution.js'

setupIntTest()

function ev(id: string, name: string, topicName: string, endMinutesAgo = 0): EventCandidate {
  return { id, name, topicName, endTime: new Date(Date.parse('2026-06-01T00:00:00.000Z') - endMinutesAgo * 60 * 1000) }
}

describe('resolveTrendScope', () => {
  const candidates = [
    ev('1', 'AI Ethics Session 1', 'AI Ethics', 3000),
    ev('2', 'AI Ethics Session 2', 'AI Ethics', 2000),
    ev('3', 'Budget Review', 'Finance', 1000)
  ]

  it('scopes to the matching topic when the query names a series', () => {
    const scoped = resolveTrendScope({ eventQuery: 'AI Ethics', latestInTopic: false, trend: true }, candidates)
    expect(scoped.map((candidate) => candidate.id).sort()).toEqual(['1', '2'])
  })

  it('falls back to every public event when the query names no topic', () => {
    const scoped = resolveTrendScope({ eventQuery: '', latestInTopic: false, trend: true }, candidates)
    expect(scoped.map((candidate) => candidate.id).sort()).toEqual(['1', '2', '3'])
  })

  it('falls back to every public event when the query matches no topic', () => {
    const scoped = resolveTrendScope({ eventQuery: 'Climate Policy', latestInTopic: false, trend: true }, candidates)
    expect(scoped).toHaveLength(3)
  })
})

describe('trendEventCount', () => {
  it('uses the requested count', () => {
    expect(trendEventCount({ eventQuery: '', latestInTopic: false, trend: true, eventCount: 3 })).toBe(3)
  })

  it('defaults when no count was given', () => {
    expect(trendEventCount({ eventQuery: '', latestInTopic: false, trend: true, eventCount: null })).toBe(
      DEFAULT_TREND_EVENTS
    )
  })

  it('clamps to a sane bound', () => {
    expect(trendEventCount({ eventQuery: '', latestInTopic: false, trend: true, eventCount: 999 })).toBeLessThanOrEqual(10)
    expect(trendEventCount({ eventQuery: '', latestInTopic: false, trend: true, eventCount: 0 })).toBeGreaterThanOrEqual(1)
  })
})

describe('fetchTrendSnapshots', () => {
  async function seedSnapshot(conversationId: mongoose.Types.ObjectId, endTime: Date, version = METRICS_VERSION) {
    return EventMetricsSnapshot.create({
      conversationId,
      topicId: new mongoose.Types.ObjectId(),
      eventName: 'Series event',
      eventEndTime: endTime,
      eventPlatform: 'nextspace',
      metricsVersion: version,
      capturedAt: endTime,
      posterCount: 5,
      messageCount: 50,
      frequentPosterCount: 1,
      frequentPosterMessageShare: 0.3,
      trackedSessionStatus: 'available',
      trackedSessions: 20,
      participantCount: 20,
      lurkerCount: 15,
      participationRate: 0.25,
      postersExceedTrackedSessions: false,
      avgDwellSeconds: 600,
      totalActions: 200,
      channelSplit: { public: 48, private: 2 },
      botInvocationCount: 3,
      resourceSummary: { total: 2, required: 1, referenced: 1, suggested: 0, withLinks: 2 },
      spikeCount: 1,
      receptionCount: 2
    })
  }

  it('reads snapshots only for the scoped (public) conversations, newest first, up to the limit', async () => {
    const inScope = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
    const privateConversation = new mongoose.Types.ObjectId()

    await seedSnapshot(inScope[0], new Date('2026-05-01T00:00:00.000Z'))
    await seedSnapshot(inScope[1], new Date('2026-05-15T00:00:00.000Z'))
    await seedSnapshot(inScope[2], new Date('2026-05-30T00:00:00.000Z'))
    // A snapshot for a conversation NOT in the scoped (public) candidate set must never be read.
    await seedSnapshot(privateConversation, new Date('2026-05-31T00:00:00.000Z'))

    const scoped = inScope.map((id, index) => ev(id.toString(), `Event ${index}`, 'Series'))
    const snapshots = await fetchTrendSnapshots(scoped, 2)

    expect(snapshots).toHaveLength(2)
    // Newest first: May 30 then May 15. The private conversation's later snapshot is absent.
    expect(snapshots[0].conversationId.toString()).toBe(inScope[2].toString())
    expect(snapshots[1].conversationId.toString()).toBe(inScope[1].toString())
    expect(snapshots.some((snapshot) => snapshot.conversationId.toString() === privateConversation.toString())).toBe(false)
  })

  it('ignores snapshots stamped with a different metrics version', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    await seedSnapshot(conversationId, new Date('2026-05-01T00:00:00.000Z'), METRICS_VERSION + 1)

    const snapshots = await fetchTrendSnapshots([ev(conversationId.toString(), 'Event', 'Series')], 5)
    expect(snapshots).toHaveLength(0)
  })
})
