import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { Conversation, Message, ConversationAnalytics, EventMetricsSnapshot } from '../../../src/models/index.js'
import { METRICS_VERSION } from '../../../src/services/conversationAnalytics.service.js'
import { backfillEventMetricsSnapshots } from '../../../scripts/backfillEventMetricsSnapshots.js'

setupIntTest()

const ownerId = new mongoose.Types.ObjectId()

/* An ended event with a couple of posters, optionally with a stored web-analytics summary
   (Matomo data) and optionally experimental. The summary is what marks Matomo as "wired up";
   without it the backfill should skip the event. */
async function seedEndedEvent(options: { tracked?: boolean; experimental?: boolean } = {}) {
  const conversation = await Conversation.create({
    name: 'Past event',
    slug: `past-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: new mongoose.Types.ObjectId(),
    endTime: new Date('2026-06-01T12:00:00.000Z'),
    experimental: options.experimental ?? false,
    transcript: { status: 'stopped' }
  })
  await Message.create([
    {
      body: 'hi',
      conversation: conversation._id,
      owner: new mongoose.Types.ObjectId(),
      pseudonymId: ownerId,
      pseudonym: 'a',
      fromAgent: false
    },
    {
      body: 'yo',
      conversation: conversation._id,
      owner: new mongoose.Types.ObjectId(),
      pseudonymId: ownerId,
      pseudonym: 'b',
      fromAgent: false
    }
  ])
  if (options.tracked) {
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 10,
      totalVisits: 10,
      totalActions: 100,
      totalDwellSeconds: 5000,
      deviceBreakdown: {},
      source: 'matomo',
      capturedAt: new Date('2026-06-01T12:05:00.000Z')
    })
  }
  return conversation
}

describe('backfillEventMetricsSnapshots', () => {
  it('snapshots ended events that had web analytics wired up', async () => {
    const tracked = await seedEndedEvent({ tracked: true })

    const summary = await backfillEventMetricsSnapshots()

    expect(summary.backfilled).toBe(1)
    const stored = await EventMetricsSnapshot.findOne({ conversationId: tracked._id })
    expect(stored).not.toBeNull()
    expect(stored!.posterCount).toBe(2)
    expect(stored!.metricsVersion).toBe(METRICS_VERSION)
    // The reception pass never ran in a scalar recompute, so the count is unknown, not zero.
    expect(stored!.receptionCount).toBeNull()
  })

  it('skips events that never had web analytics wired up', async () => {
    const untracked = await seedEndedEvent({ tracked: false })

    const summary = await backfillEventMetricsSnapshots()

    expect(summary.skippedNoTrackedData).toBe(1)
    expect(summary.backfilled).toBe(0)
    const stored = await EventMetricsSnapshot.findOne({ conversationId: untracked._id })
    expect(stored).toBeNull()
  })

  it('skips an event that already has a snapshot for this metrics version', async () => {
    const tracked = await seedEndedEvent({ tracked: true })
    await backfillEventMetricsSnapshots()

    const summary = await backfillEventMetricsSnapshots()

    expect(summary.skippedExisting).toBe(1)
    expect(summary.backfilled).toBe(0)
    const stored = await EventMetricsSnapshot.find({ conversationId: tracked._id })
    expect(stored).toHaveLength(1)
  })

  it('never snapshots experimental events', async () => {
    const experimental = await seedEndedEvent({ tracked: true, experimental: true })

    const summary = await backfillEventMetricsSnapshots()

    expect(summary.backfilled).toBe(0)
    const stored = await EventMetricsSnapshot.findOne({ conversationId: experimental._id })
    expect(stored).toBeNull()
  })

  it('writes nothing on a dry run but still reports what it would do', async () => {
    const tracked = await seedEndedEvent({ tracked: true })

    const summary = await backfillEventMetricsSnapshots({ dryRun: true })

    expect(summary.backfilled).toBe(1)
    const stored = await EventMetricsSnapshot.findOne({ conversationId: tracked._id })
    expect(stored).toBeNull()
  })
})
