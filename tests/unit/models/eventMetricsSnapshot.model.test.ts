import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { EventMetricsSnapshot } from '../../../src/models/index.js'

setupIntTest()

/* A full per-event snapshot: scalar aggregates only, one document per event per metrics
   version. No verbatim quote text from spikes or receptions ever lands here. */
const sampleSnapshot = () => ({
  conversationId: new mongoose.Types.ObjectId(),
  topicId: new mongoose.Types.ObjectId(),
  eventName: 'Future of Work',
  eventEndTime: new Date('2026-06-10T18:00:00.000Z'),
  eventPlatform: 'nextspace' as const,
  metricsVersion: 1,
  capturedAt: new Date('2026-06-10T18:05:00.000Z'),
  posterCount: 12,
  messageCount: 140,
  frequentPosterCount: 2,
  frequentPosterMessageShare: 0.45,
  trackedSessionStatus: 'available' as const,
  trackedSessions: 90,
  participantCount: 80,
  lurkerCount: 68,
  participationRate: 0.15,
  postersExceedTrackedSessions: false,
  avgDwellSeconds: 420,
  totalActions: 950,
  actionBreakdown: { 'command:visual': 12, 'tab:chat': 8 },
  actionUserBreakdown: { 'command:visual': 5, 'tab:chat': 4 },
  activeVisitorCount: 40,
  channelSplit: { public: 130, private: 10 },
  privateMessageCount: 10,
  distinctPrivateSenders: 3,
  distinctPublicSenders: 11,
  botInvocationCount: 7,
  resourceSummary: { total: 4, required: 2, referenced: 1, suggested: 1, withLinks: 3 },
  spikeCount: 2,
  receptionCount: 3
})

describe('EventMetricsSnapshot model', () => {
  beforeAll(async () => {
    // Build the unique index so the duplicate test can rely on it.
    await EventMetricsSnapshot.syncIndexes()
  })

  it('persists every scalar metric and reads it back', async () => {
    const snapshot = sampleSnapshot()
    await EventMetricsSnapshot.create(snapshot)

    const stored = await EventMetricsSnapshot.findOne({ conversationId: snapshot.conversationId })
    expect(stored).not.toBeNull()
    expect(stored!.posterCount).toBe(12)
    expect(stored!.messageCount).toBe(140)
    expect(stored!.frequentPosterCount).toBe(2)
    expect(stored!.frequentPosterMessageShare).toBe(0.45)
    expect(stored!.trackedSessionStatus).toBe('available')
    expect(stored!.participantCount).toBe(80)
    expect(stored!.lurkerCount).toBe(68)
    expect(stored!.participationRate).toBe(0.15)
    expect(stored!.avgDwellSeconds).toBe(420)
    expect(stored!.totalActions).toBe(950)
    expect(stored!.channelSplit).toMatchObject({ public: 130, private: 10 })
    expect(stored!.actionBreakdown).toMatchObject({ 'command:visual': 12, 'tab:chat': 8 })
    expect(stored!.actionUserBreakdown).toMatchObject({ 'command:visual': 5, 'tab:chat': 4 })
    expect(stored!.activeVisitorCount).toBe(40)
    expect(stored!.privateMessageCount).toBe(10)
    expect(stored!.distinctPrivateSenders).toBe(3)
    expect(stored!.distinctPublicSenders).toBe(11)
    expect(stored!.botInvocationCount).toBe(7)
    expect(stored!.resourceSummary).toMatchObject({ total: 4, required: 2, referenced: 1, suggested: 1, withLinks: 3 })
    expect(stored!.spikeCount).toBe(2)
    expect(stored!.receptionCount).toBe(3)
    expect(stored!.metricsVersion).toBe(1)
    expect(stored!.eventEndTime).toEqual(new Date('2026-06-10T18:00:00.000Z'))
    expect(stored!.capturedAt).toEqual(new Date('2026-06-10T18:05:00.000Z'))
  })

  it('allows a null receptionCount and null tracked-session estimates', async () => {
    const snapshot = {
      ...sampleSnapshot(),
      receptionCount: null,
      trackedSessionStatus: 'notTracked' as const,
      participantCount: null,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: null,
      avgDwellSeconds: null,
      totalActions: null
    }
    await EventMetricsSnapshot.create(snapshot)

    const stored = await EventMetricsSnapshot.findOne({ conversationId: snapshot.conversationId })
    expect(stored!.receptionCount).toBeNull()
    expect(stored!.participantCount).toBeNull()
    expect(stored!.lurkerCount).toBeNull()
  })

  it('rejects a second snapshot for the same conversation and metrics version', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    await EventMetricsSnapshot.create({ ...sampleSnapshot(), conversationId, metricsVersion: 1 })

    await expect(EventMetricsSnapshot.create({ ...sampleSnapshot(), conversationId, metricsVersion: 1 })).rejects.toThrow()
  })

  it('lets the same conversation hold a snapshot per metrics version', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    await EventMetricsSnapshot.create({ ...sampleSnapshot(), conversationId, metricsVersion: 1 })

    await expect(
      EventMetricsSnapshot.create({ ...sampleSnapshot(), conversationId, metricsVersion: 2 })
    ).resolves.toBeDefined()

    const stored = await EventMetricsSnapshot.find({ conversationId })
    expect(stored.map((doc) => doc.metricsVersion).sort()).toEqual([1, 2])
  })

  it('carries no verbatim quote text from spikes or receptions', async () => {
    const paths = Object.keys(EventMetricsSnapshot.schema.paths)
    // The quote-bearing fields are spike.annotation.{topic,quote} and
    // reception.{sparkQuote,reactionQuote}; none of their words may appear as a stored path.
    for (const forbidden of ['quote', 'annotation', 'spark', 'reaction']) {
      expect(paths.some((path) => path.toLowerCase().includes(forbidden))).toBe(false)
    }
  })
})
