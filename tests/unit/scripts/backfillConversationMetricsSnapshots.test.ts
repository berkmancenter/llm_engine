import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { Conversation, Message, ConversationAnalytics, ConversationMetricsSnapshot } from '../../../src/models/index.js'
import { METRICS_VERSION } from '../../../src/services/conversationAnalytics.service.js'
import {
  backfillConversationMetricsSnapshots,
  formatEventsTable,
  type BackfilledEvent,
  type SnapshotMetricsView
} from '../../../scripts/backfillConversationMetricsSnapshots.js'

setupIntTest()

const ownerId = new mongoose.Types.ObjectId()

// A fixed reference "now" so the age-window filtering is deterministic regardless of the clock.
const NOW = new Date('2026-07-01T00:00:00.000Z')

/* An ended event with a couple of posters, optionally with a stored web-analytics summary
   (Matomo data) and optionally experimental. The summary is what marks Matomo as "wired up";
   without it the backfill should skip the event. endTime sets how long ago the event ended,
   which is what the age window filters on. */
async function seedEndedEvent(
  options: { tracked?: boolean; experimental?: boolean; endTime?: Date; speakers?: string[] } = {}
) {
  const conversation = await Conversation.create({
    name: 'Past event',
    slug: `past-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: new mongoose.Types.ObjectId(),
    endTime: options.endTime ?? new Date('2026-06-20T12:00:00.000Z'),
    experimental: options.experimental ?? false,
    transcript: { status: 'stopped' }
  })
  const speakers = options.speakers ?? ['a', 'b']
  await Message.create(
    speakers.map((pseudonym) => ({
      body: 'hi',
      conversation: conversation._id,
      owner: new mongoose.Types.ObjectId(),
      pseudonymId: ownerId,
      pseudonym,
      fromAgent: false
    }))
  )
  if (options.tracked) {
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 10,
      totalVisits: 10,
      totalActions: 100,
      totalDwellSeconds: 5000, // avg dwell 500s
      deviceBreakdown: {},
      source: 'matomo',
      capturedAt: new Date('2026-06-20T12:05:00.000Z')
    })
  }
  return conversation
}

describe('backfillConversationMetricsSnapshots', () => {
  it('snapshots ended events that had web analytics wired up and reports their metrics', async () => {
    const tracked = await seedEndedEvent({ tracked: true })

    const summary = await backfillConversationMetricsSnapshots({ now: NOW })

    expect(summary.backfilled).toBe(1)
    expect(summary.events).toHaveLength(1)
    const [event] = summary.events
    // First run: nothing existed before, so before is null and after carries the written metrics.
    expect(event.before).toBeNull()
    expect(event.after.posterCount).toBe(2)
    expect(event.after.lurkerCount).toBe(8)
    expect(event.after.avgDwellSeconds).toBe(500)
    expect(event.after.receptionCount).toBeNull()

    const stored = await ConversationMetricsSnapshot.findOne({ conversationId: tracked._id })
    expect(stored!.posterCount).toBe(2)
    expect(stored!.metricsVersion).toBe(METRICS_VERSION)
  })

  it('skips events that never had web analytics wired up', async () => {
    const untracked = await seedEndedEvent({ tracked: false })

    const summary = await backfillConversationMetricsSnapshots({ now: NOW })

    expect(summary.skippedNoTrackedData).toBe(1)
    expect(summary.backfilled).toBe(0)
    expect(summary.events).toHaveLength(0)
    const stored = await ConversationMetricsSnapshot.findOne({ conversationId: untracked._id })
    expect(stored).toBeNull()
  })

  it('skips an event that already has a snapshot for this metrics version', async () => {
    const tracked = await seedEndedEvent({ tracked: true })
    await backfillConversationMetricsSnapshots({ now: NOW })

    const summary = await backfillConversationMetricsSnapshots({ now: NOW })

    expect(summary.skippedExisting).toBe(1)
    expect(summary.backfilled).toBe(0)
    const stored = await ConversationMetricsSnapshot.find({ conversationId: tracked._id })
    expect(stored).toHaveLength(1)
  })

  it('never snapshots experimental events', async () => {
    const experimental = await seedEndedEvent({ tracked: true, experimental: true })

    const summary = await backfillConversationMetricsSnapshots({ now: NOW })

    expect(summary.backfilled).toBe(0)
    const stored = await ConversationMetricsSnapshot.findOne({ conversationId: experimental._id })
    expect(stored).toBeNull()
  })

  it('previews the would-be metrics on a dry run but writes nothing', async () => {
    const tracked = await seedEndedEvent({ tracked: true })

    const summary = await backfillConversationMetricsSnapshots({ now: NOW, dryRun: true })

    expect(summary.backfilled).toBe(1)
    // The preview still shows what each event would store.
    expect(summary.events[0].after.posterCount).toBe(2)
    const stored = await ConversationMetricsSnapshot.findOne({ conversationId: tracked._id })
    expect(stored).toBeNull()
  })

  it('only processes events whose end falls inside the age window', async () => {
    // 11 days old (inside a 0-30 day window).
    const recent = await seedEndedEvent({ tracked: true, endTime: new Date('2026-06-20T00:00:00.000Z') })
    // 47 days old (outside 0-30, inside 30-60).
    const older = await seedEndedEvent({ tracked: true, endTime: new Date('2026-05-15T00:00:00.000Z') })

    const firstBatch = await backfillConversationMetricsSnapshots({ now: NOW, minAgeDays: 0, maxAgeDays: 30 })
    expect(firstBatch.scanned).toBe(1)
    expect(firstBatch.backfilled).toBe(1)
    expect(await ConversationMetricsSnapshot.findOne({ conversationId: recent._id })).not.toBeNull()
    expect(await ConversationMetricsSnapshot.findOne({ conversationId: older._id })).toBeNull()

    const secondBatch = await backfillConversationMetricsSnapshots({ now: NOW, minAgeDays: 30, maxAgeDays: 60 })
    expect(secondBatch.scanned).toBe(1)
    expect(secondBatch.backfilled).toBe(1)
    expect(await ConversationMetricsSnapshot.findOne({ conversationId: older._id })).not.toBeNull()
  })

  it('overwrites an existing snapshot and reports the before and after when asked', async () => {
    const tracked = await seedEndedEvent({ tracked: true, speakers: ['a', 'b'] })
    await backfillConversationMetricsSnapshots({ now: NOW })

    // A third person posts after the first snapshot was taken, so the recomputed poster count rises.
    await Message.create({
      body: 'late',
      conversation: tracked._id,
      owner: new mongoose.Types.ObjectId(),
      pseudonymId: ownerId,
      pseudonym: 'c',
      fromAgent: false
    })

    const summary = await backfillConversationMetricsSnapshots({ now: NOW, overwrite: true })

    expect(summary.backfilled).toBe(1)
    expect(summary.skippedExisting).toBe(0)
    const [event] = summary.events
    expect(event.before!.posterCount).toBe(2)
    expect(event.after.posterCount).toBe(3)

    const stored = await ConversationMetricsSnapshot.find({ conversationId: tracked._id })
    expect(stored).toHaveLength(1)
    expect(stored[0].posterCount).toBe(3)
  })
})

describe('formatEventsTable', () => {
  const metrics = (overrides: Partial<SnapshotMetricsView> = {}): SnapshotMetricsView => ({
    posterCount: 10,
    messageCount: 10,
    lurkerCount: null,
    participationRate: null,
    avgDwellSeconds: null,
    channelSplit: { public: 0, private: 0 },
    botInvocationCount: 0,
    spikeCount: 0,
    receptionCount: null,
    ...overrides
  })

  it('pads every row so a column lines up under its header regardless of value width', () => {
    const events: BackfilledEvent[] = [
      {
        conversationId: '1',
        name: 'Short',
        endTime: new Date('2026-06-01T12:00:00.000Z'),
        before: null,
        after: metrics({ posterCount: 5 })
      },
      {
        conversationId: '2',
        name: 'A Much Longer Event Name',
        endTime: new Date('2026-06-02T12:00:00.000Z'),
        before: null,
        after: metrics({ posterCount: 500 })
      }
    ]

    const [header, first, second] = formatEventsTable(events)
    const postersColumnStart = header.indexOf('Posters')

    expect(first.indexOf('5')).toBe(postersColumnStart)
    expect(second.indexOf('500')).toBe(postersColumnStart)
  })

  it('renders the event date in Boston time, not UTC', () => {
    const events: BackfilledEvent[] = [
      {
        conversationId: '1',
        name: 'Late Night Event',
        // 2am UTC on Jul 1 is 10pm on Jun 30 in Boston, so the report should read Jun 30.
        endTime: new Date('2026-07-01T02:00:00.000Z'),
        before: null,
        after: metrics()
      }
    ]

    const [, row] = formatEventsTable(events)

    expect(row).toContain('2026-06-30')
    expect(row).not.toContain('2026-07-01')
  })

  it('shows a before -> after arrow only for fields that actually changed on an overwrite', () => {
    const events: BackfilledEvent[] = [
      {
        conversationId: '1',
        name: 'Overwritten event',
        endTime: new Date('2026-06-01T12:00:00.000Z'),
        before: metrics({ posterCount: 8, lurkerCount: 2 }),
        after: metrics({ posterCount: 10, lurkerCount: 2 })
      }
    ]

    const [, row] = formatEventsTable(events)

    expect(row).toContain('8 -> 10')
    expect(row).not.toContain('2 -> 2')
  })
})
