import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { ConversationAnalytics } from '../../../src/models/index.js'

setupIntTest()

/* A Matomo-sourced snapshot: counts and sums only, one doc per conversation. */
const sampleSnapshot = () => ({
  conversationId: new mongoose.Types.ObjectId(),
  attendeeCount: 50,
  totalVisits: 120,
  totalActions: 940,
  totalDwellSeconds: 36000,
  deviceBreakdown: { desktop: 80, mobile: 35, tablet: 5 },
  source: 'matomo',
  capturedAt: new Date('2026-06-10T00:00:00.000Z')
})

describe('ConversationAnalytics model', () => {
  beforeAll(async () => {
    // Build the unique index so the duplicate-conversation test can rely on it.
    await ConversationAnalytics.syncIndexes()
  })

  it('persists the snapshot counts and sums and reads them back', async () => {
    const snapshot = sampleSnapshot()
    await ConversationAnalytics.create(snapshot)

    const stored = await ConversationAnalytics.findOne({ conversationId: snapshot.conversationId })
    expect(stored).not.toBeNull()
    expect(stored!.attendeeCount).toBe(50)
    expect(stored!.totalVisits).toBe(120)
    expect(stored!.totalActions).toBe(940)
    expect(stored!.totalDwellSeconds).toBe(36000)
    expect(stored!.deviceBreakdown).toMatchObject({ desktop: 80, mobile: 35, tablet: 5 })
    expect(stored!.source).toBe('matomo')
    expect(stored!.capturedAt).toEqual(new Date('2026-06-10T00:00:00.000Z'))
  })

  it('lets two analytics sources store a snapshot for the same conversation', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    await ConversationAnalytics.create({ ...sampleSnapshot(), conversationId, source: 'matomo' })

    await expect(
      ConversationAnalytics.create({ ...sampleSnapshot(), conversationId, source: 'plausible' })
    ).resolves.toBeDefined()

    const stored = await ConversationAnalytics.find({ conversationId })
    expect(stored.map((doc) => doc.source).sort()).toEqual(['matomo', 'plausible'])
  })

  it('rejects a second snapshot from the same source for one conversation', async () => {
    const conversationId = new mongoose.Types.ObjectId()
    await ConversationAnalytics.create({ ...sampleSnapshot(), conversationId, source: 'matomo' })

    await expect(ConversationAnalytics.create({ ...sampleSnapshot(), conversationId, source: 'matomo' })).rejects.toThrow()
  })

  it('carries no pseudonym or per-attendee identity fields', async () => {
    const paths = Object.keys(ConversationAnalytics.schema.paths)
    expect(paths).not.toContain('pseudonym')
    expect(paths).not.toContain('pseudonyms')
    expect(paths).not.toContain('userId')
    expect(paths).not.toContain('affectedUsers')
    // No nested path should reference a pseudonym either.
    expect(paths.some((path) => path.toLowerCase().includes('pseudonym'))).toBe(false)
  })
})
