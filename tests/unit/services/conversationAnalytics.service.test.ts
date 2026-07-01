import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import { Conversation, Message, ConversationAnalytics, Channel } from '../../../src/models/index.js'
import conversationAnalyticsService, {
  attributeSpikeSources,
  computeResourceSummary,
  deriveEventPlatform,
  spikeSourceForChannels
} from '../../../src/services/conversationAnalytics.service.js'
import { ChatSpike } from '../../../src/types/index.types.js'
import config from '../../../src/config/config.js'

setupIntTest()

const ownerId = new mongoose.Types.ObjectId()

/* Participation is now counted per person (owner), not per pseudonym, so every distinct
   persona in a fixture needs its own owner id or they collapse into one poster. This maps
   each pseudonym to a stable owner id so a persona keeps the same owner across its
   messages while different personas stay distinct. */
const ownerByPseudonym = new Map<string, mongoose.Types.ObjectId>()
function ownerFor(pseudonym: string): mongoose.Types.ObjectId {
  if (!ownerByPseudonym.has(pseudonym)) {
    ownerByPseudonym.set(pseudonym, new mongoose.Types.ObjectId())
  }
  return ownerByPseudonym.get(pseudonym)!
}

/* Two posters: 'ana' sends two messages and 'bo' one (three total); one agent
   message that must not count. So posterCount is 2 and 'ana' is the busiest poster. */
async function seedParticipation(conversationId: mongoose.Types.ObjectId) {
  await Message.create([
    {
      body: 'hi',
      conversation: conversationId,
      owner: ownerFor('ana'),
      pseudonymId: ownerId,
      pseudonym: 'ana',
      fromAgent: false
    },
    {
      body: 'yo',
      conversation: conversationId,
      owner: ownerFor('ana'),
      pseudonymId: ownerId,
      pseudonym: 'ana',
      fromAgent: false
    },
    {
      body: 'hey',
      conversation: conversationId,
      owner: ownerFor('bo'),
      pseudonymId: ownerId,
      pseudonym: 'bo',
      fromAgent: false
    },
    { body: 'beep', conversation: conversationId, owner: ownerId, pseudonymId: ownerId, pseudonym: 'bot', fromAgent: true }
  ])
}

async function makeConversation() {
  const conversation = await Conversation.create({
    name: 'Phase 5 metrics event',
    slug: `phase5-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: new mongoose.Types.ObjectId(),
    transcript: { status: 'stopped' }
  })
  return conversation
}

/* Makes an event with an explicit start/end window so the activity buckets are
   deterministic regardless of when the test runs. */
async function makeConversationWithWindow(start: Date, end: Date) {
  return Conversation.create({
    name: 'Windowed metrics event',
    slug: `window-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: new mongoose.Types.ObjectId(),
    startTime: start,
    endTime: end,
    transcript: { status: 'stopped' }
  })
}

/* Seeds one message at a fixed offset into the event. timestamps:true stamps
   createdAt to now and marks it immutable, so the offset is forced through the
   native driver, which bypasses Mongoose casting and the immutable guard. */
async function seedMessageAt(
  conversationId: mongoose.Types.ObjectId,
  start: Date,
  minutesFromStart: number,
  fromAgent = false
) {
  const [message] = await Message.create([
    { body: 'm', conversation: conversationId, owner: ownerId, pseudonymId: ownerId, pseudonym: 'ana', fromAgent }
  ])
  const createdAt = new Date(start.getTime() + minutesFromStart * 60 * 1000)
  await Message.collection.updateOne({ _id: message._id }, { $set: { createdAt } })
}

/* Seeds one participant message on the given channels at a set minute past the event
   start, so a spike can be built from a specific channel like a private 1:1. */
async function seedMessageOnChannelAt(
  conversationId: mongoose.Types.ObjectId,
  start: Date,
  minutesFromStart: number,
  channels: string[]
) {
  const [message] = await Message.create([
    {
      body: 'm',
      conversation: conversationId,
      owner: ownerId,
      pseudonymId: ownerId,
      pseudonym: 'ana',
      fromAgent: false,
      channels
    }
  ])
  const createdAt = new Date(start.getTime() + minutesFromStart * 60 * 1000)
  await Message.collection.updateOne({ _id: message._id }, { $set: { createdAt } })
}

describe('computeConversationMetrics', () => {
  it('computes participation from Mongo and derives attention ratios from the snapshot', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id)
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 40,
      totalVisits: 100,
      totalActions: 800,
      totalDwellSeconds: 30000,
      deviceBreakdown: { desktop: 70, mobile: 30 },
      source: 'matomo',
      capturedAt: new Date('2026-06-12T00:00:00.000Z')
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // Two posters is below the handful threshold, so no frequent posters and a null share.
    expect(metrics.participation).toMatchObject({ posterCount: 2, frequentPosterCount: 0, messageCount: 3 })
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
    expect(metrics.audienceEngagement).toEqual({
      participantCount: 40,
      lurkerCount: 38,
      participationRate: 0.05,
      postersExceedTrackedSessions: false
    })
    expect(metrics.trackedSessionStatus).toBe('available')
    expect(metrics.trackedSessionSources).toHaveLength(1)
    const [matomo] = metrics.trackedSessionSources
    expect(matomo.trackedSessions).toBe(100)
    expect(matomo.attendeeCount).toBe(40)
    expect(matomo.avgDwellSeconds).toBe(300) // 30000 / 100
    expect(matomo.deviceBreakdown).toMatchObject({ desktop: 70, mobile: 30 })
    expect(matomo.source).toBe('matomo')
  })

  it('returns participation and no tracked sessions when no source is referenced or stored', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation).toMatchObject({ posterCount: 2, frequentPosterCount: 0, messageCount: 3 })
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
    expect(metrics.audienceEngagement).toBeNull()
    expect(metrics.trackedSessionSources).toEqual([])
    expect(metrics.trackedSessionStatus).toBe('notTracked')
  })

  it('reports tracked sessions as unavailable when a source is referenced but no snapshot exists', async () => {
    const conversation = await Conversation.create({
      name: 'Referenced but no snapshot',
      slug: `unavailable-${new mongoose.Types.ObjectId().toString()}`,
      owner: ownerId,
      topic: new mongoose.Types.ObjectId(),
      analyticsRefs: { matomo: 'dimension7' },
      transcript: { status: 'stopped' }
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.trackedSessionSources).toEqual([])
    expect(metrics.trackedSessionStatus).toBe('unavailable')
  })

  it('returns null ratios, not a fake zero, when tracked but no visitors showed up', async () => {
    const conversation = await makeConversation()
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 0,
      totalVisits: 0,
      totalActions: 0,
      totalDwellSeconds: 0,
      deviceBreakdown: {},
      source: 'matomo',
      capturedAt: new Date('2026-06-12T00:00:00.000Z')
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    const [matomo] = metrics.trackedSessionSources
    expect(matomo.avgDwellSeconds).toBe(0)
    expect(metrics.audienceEngagement).toEqual({
      participantCount: 0,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: false
    })
  })
})

/* Twelve posters: two heavy posters send five messages each and the other ten send
   one each (20 messages total). The top 10% of 12 is ceil(1.2) = 2 frequent posters,
   who between them account for half the messages. */
async function seedSkewedPosters(conversationId: mongoose.Types.ObjectId) {
  const heavy = ['p1', 'p2']
  const light = Array.from({ length: 10 }, (_, index) => `q${index + 1}`)
  await Message.create([
    ...heavy.flatMap((pseudonym) =>
      Array.from({ length: 5 }, () => ({
        body: 'm',
        conversation: conversationId,
        owner: ownerFor(pseudonym),
        pseudonymId: ownerId,
        pseudonym,
        fromAgent: false
      }))
    ),
    ...light.map((pseudonym) => ({
      body: 'm',
      conversation: conversationId,
      owner: ownerFor(pseudonym),
      pseudonymId: ownerId,
      pseudonym,
      fromAgent: false
    }))
  ])
}

describe('computeConversationMetrics pseudonym rotation', () => {
  it('counts one person posting under two pseudonyms as a single poster', async () => {
    const conversation = await makeConversation()
    const rosaId = new mongoose.Types.ObjectId()
    /* One person whose pseudonym rotated mid-event: same owner, two pseudonym
       strings. They must register as one poster, not two. */
    await Message.create([
      {
        body: 'first',
        conversation: conversation._id,
        owner: rosaId,
        pseudonymId: rosaId,
        pseudonym: 'rosa-1',
        fromAgent: false
      },
      {
        body: 'second',
        conversation: conversation._id,
        owner: rosaId,
        pseudonymId: rosaId,
        pseudonym: 'rosa-2',
        fromAgent: false
      }
    ])

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation.posterCount).toBe(1)
    expect(metrics.participation.messageCount).toBe(2)
    expect(metrics.participation.frequentPosterCount).toBe(0)
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
  })

  it('counts an owner-less guest with one pseudonym id but differing display names as one poster', async () => {
    const conversation = await makeConversation()
    const guestPseudonymId = new mongoose.Types.ObjectId()
    /* Two messages from one guest (no owner). The display pseudonym differs between them
       but the pseudonym id is the same, so the stable id, not the string, proves they are
       one person. */
    await Message.create([
      {
        body: 'first',
        conversation: conversation._id,
        pseudonymId: guestPseudonymId,
        pseudonym: 'guest-a',
        fromAgent: false
      },
      {
        body: 'second',
        conversation: conversation._id,
        pseudonymId: guestPseudonymId,
        pseudonym: 'guest-b',
        fromAgent: false
      }
    ])

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation.posterCount).toBe(1)
    expect(metrics.participation.messageCount).toBe(2)
  })
})

describe('computeConversationMetrics frequent posters', () => {
  it('flags the top 10% of posters by message volume and their message share', async () => {
    const conversation = await makeConversation()
    await seedSkewedPosters(conversation._id)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation.posterCount).toBe(12)
    expect(metrics.participation.frequentPosterCount).toBe(2) // ceil(0.1 * 12)
    expect(metrics.participation.messageCount).toBe(20)
    expect(metrics.participation.frequentPosterMessageShare).toBeCloseTo(0.5, 5) // 10 of 20
  })

  it('reports a null share and no frequent posters below a handful of posters', async () => {
    const conversation = await makeConversation()
    // Only one poster, well below the handful threshold, so a dominance share is meaningless.
    await Message.create([
      {
        body: 'solo',
        conversation: conversation._id,
        owner: ownerFor('solo'),
        pseudonymId: ownerId,
        pseudonym: 'solo',
        fromAgent: false
      }
    ])

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation.posterCount).toBe(1)
    expect(metrics.participation.frequentPosterCount).toBe(0)
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
  })

  it('includes every poster tied at the cutoff message count, not just the top slice', async () => {
    const conversation = await makeConversation()
    // Six posters: three tie at five messages each, three send one each (18 total). The
    // top 10% of 6 is ceil(0.6) = 1, but two more posters tie that busiest at five, so a
    // tie-aware cut includes all three heavy posters rather than picking one arbitrarily.
    const heavy = ['h1', 'h2', 'h3']
    const light = ['l1', 'l2', 'l3']
    await Message.create([
      ...heavy.flatMap((pseudonym) =>
        Array.from({ length: 5 }, () => ({
          body: 'm',
          conversation: conversation._id,
          owner: ownerFor(pseudonym),
          pseudonymId: ownerId,
          pseudonym,
          fromAgent: false
        }))
      ),
      ...light.map((pseudonym) => ({
        body: 'm',
        conversation: conversation._id,
        owner: ownerFor(pseudonym),
        pseudonymId: ownerId,
        pseudonym,
        fromAgent: false
      }))
    ])

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation.posterCount).toBe(6)
    expect(metrics.participation.frequentPosterCount).toBe(3) // all three tied at five, not ceil(0.6)=1
    expect(metrics.participation.messageCount).toBe(18)
    expect(metrics.participation.frequentPosterMessageShare).toBeCloseTo(15 / 18, 5)
  })
})

describe('computeConversationMetrics audience engagement', () => {
  it('returns null lurkers and rate and flags the mismatch when posters exceed tracked sessions', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id) // 2 posters
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 1,
      totalVisits: 1,
      totalActions: 1,
      totalDwellSeconds: 10,
      deviceBreakdown: {},
      source: 'matomo',
      capturedAt: new Date('2026-06-12T00:00:00.000Z')
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.audienceEngagement).toEqual({
      participantCount: 1,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    })
  })

  it('reports real lurkers and rate with the flag false when the counts reconcile', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id) // 2 posters
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 5,
      totalVisits: 5,
      totalActions: 5,
      totalDwellSeconds: 50,
      deviceBreakdown: {},
      source: 'matomo',
      capturedAt: new Date('2026-06-12T00:00:00.000Z')
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.audienceEngagement).toEqual({
      participantCount: 5,
      lurkerCount: 3,
      participationRate: 0.4,
      postersExceedTrackedSessions: false
    })
  })
})

describe('computeConversationMetrics activity buckets', () => {
  it('buckets non-agent messages across the event window and excludes agent messages', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 58 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)

    await seedMessageAt(conversation._id, start, 5) // bucket 0 (0-10)
    await seedMessageAt(conversation._id, start, 12) // bucket 1 (10-20)
    await seedMessageAt(conversation._id, start, 15) // bucket 1 (10-20)
    await seedMessageAt(conversation._id, start, 25) // bucket 2 (20-30)
    await seedMessageAt(conversation._id, start, 12, true) // agent message, excluded

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.activitySeries.map((bucket) => bucket.label)).toEqual([
      '0-9',
      '10-19',
      '20-29',
      '30-39',
      '40-49',
      '50-57'
    ])
    expect(metrics.activitySeries.map((bucket) => bucket.messageCount)).toEqual([1, 2, 1, 0, 0, 0])
  })

  it('labels adjacent windows so they never share a boundary number', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 58 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)

    await seedMessageAt(conversation._id, start, 5)
    await seedMessageAt(conversation._id, start, 25)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
    const labels = metrics.activitySeries.map((bucket) => bucket.label)

    // Pull the trailing number of one label and the leading number of the next; an
    // inclusive-range scheme means they must differ, so minute N belongs to one window.
    for (let index = 0; index < labels.length - 1; index += 1) {
      const endOfThis = Number(labels[index].split('-').at(-1))
      const startOfNext = Number(labels[index + 1].split('-')[0])
      expect(endOfThis).not.toBe(startOfNext)
    }
  })

  it('excludes messages sent before the event start or after the event end', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 58 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)

    await seedMessageAt(conversation._id, start, -10) // before start, excluded
    await seedMessageAt(conversation._id, start, 5) // bucket 0 (0-10)
    await seedMessageAt(conversation._id, start, 25) // bucket 2 (20-30)
    await seedMessageAt(conversation._id, start, 70) // after end, excluded

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // Only the two in-window messages are counted, and the edge buckets are not inflated.
    expect(metrics.activitySeries.reduce((sum, bucket) => sum + bucket.messageCount, 0)).toBe(2)
    expect(metrics.activitySeries.map((bucket) => bucket.messageCount)).toEqual([1, 0, 1, 0, 0, 0])
  })

  it('collapses a zero-length window to a single-number label', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    // Start and end at the same minute, so the whole event is one zero-length window.
    const conversation = await makeConversationWithWindow(start, start)

    await seedMessageAt(conversation._id, start, 0)
    await seedMessageAt(conversation._id, start, 0)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.activitySeries).toEqual([{ label: '0', messageCount: 2 }])
  })

  it('returns an empty activity series when the event has no messages', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 30 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.activitySeries).toEqual([])
  })
})

describe('computeConversationMetrics spikes', () => {
  it('flags the busy window as a spike carrying its minute range', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 58 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)

    // One message early, then a burst of six in the 20-30 window.
    await seedMessageAt(conversation._id, start, 5)
    for (const minute of [21, 22, 23, 24, 25, 26]) {
      await seedMessageAt(conversation._id, start, minute)
    }

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.spikes).toHaveLength(1)
    expect(metrics.spikes[0]).toMatchObject({ startMinute: 20, endMinute: 30, messageCount: 6 })
  })

  it('reports no spikes for an evenly spread event', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 58 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)

    for (const minute of [5, 15, 25, 35, 45]) {
      await seedMessageAt(conversation._id, start, minute)
    }

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.spikes).toEqual([])
  })

  it('marks a spike driven by private one-to-one messages as a private-source spike', async () => {
    const start = new Date('2026-06-10T10:00:00.000Z')
    const end = new Date(start.getTime() + 58 * 60 * 1000)
    const conversation = await makeConversationWithWindow(start, end)
    const directChannel = await Channel.create({
      name: `dm-${new mongoose.Types.ObjectId().toString()}`,
      direct: true,
      participants: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
    })

    // One early public message, then a burst of six private messages to the bot.
    await seedMessageAt(conversation._id, start, 5)
    for (const minute of [21, 22, 23, 24, 25, 26]) {
      await seedMessageOnChannelAt(conversation._id, start, minute, [directChannel.name])
    }

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.spikes).toHaveLength(1)
    expect(metrics.spikes[0].source).toBe('private')
  })
})

/* A bare ChatSpike for the attribution unit tests: only the window and a placeholder
   source matter, since attributeSpikeSources overwrites source from the messages. */
function spikeWindow(startMinute: number, endMinute: number): ChatSpike {
  return {
    label: `${startMinute}-${endMinute}`,
    startMinute,
    endMinute,
    messageCount: 6,
    baselineAverage: 1,
    ratio: 6,
    source: 'chat'
  }
}

describe('spikeSourceForChannels', () => {
  const directNames = new Set(['dm-1'])

  it('reads a public chat message as a chat source', () => {
    expect(spikeSourceForChannels(['chat'], directNames)).toBe('chat')
  })

  it('reads a moderator backchannel message as a moderator source', () => {
    expect(spikeSourceForChannels(['moderator'], directNames)).toBe('moderator')
  })

  it('reads a direct-channel message as a private source', () => {
    expect(spikeSourceForChannels(['dm-1'], directNames)).toBe('private')
  })

  it('treats a message with no channel as public chat', () => {
    expect(spikeSourceForChannels(undefined, directNames)).toBe('chat')
  })
})

describe('attributeSpikeSources', () => {
  const start = new Date('2026-06-10T10:00:00.000Z')
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60 * 1000)
  const directNames = new Set(['dm-1'])

  it('marks a spike private only when its window holds no readable messages', () => {
    const messages = [
      { createdAt: at(21), channels: ['dm-1'] },
      { createdAt: at(22), channels: ['dm-1'] },
      { createdAt: at(5), channels: ['chat'] } // outside the window, ignored
    ]

    const [attributed] = attributeSpikeSources([spikeWindow(20, 30)], messages, start, directNames)

    expect(attributed.source).toBe('private')
  })

  it('attributes a mixed window to the dominant readable channel', () => {
    const messages = [
      { createdAt: at(21), channels: ['moderator'] },
      { createdAt: at(22), channels: ['moderator'] },
      { createdAt: at(23), channels: ['chat'] }
    ]

    const [attributed] = attributeSpikeSources([spikeWindow(20, 30)], messages, start, directNames)

    expect(attributed.source).toBe('moderator')
  })

  it('prefers a readable channel over private when both are in the window', () => {
    const messages = [
      { createdAt: at(21), channels: ['dm-1'] },
      { createdAt: at(22), channels: ['dm-1'] },
      { createdAt: at(23), channels: ['chat'] }
    ]

    const [attributed] = attributeSpikeSources([spikeWindow(20, 30)], messages, start, directNames)

    expect(attributed.source).toBe('chat')
  })
})

describe('computeResourceSummary', () => {
  it('counts visible readings by category and how many carry a link', () => {
    const conversation = {
      resources: [
        { category: 'required', participantVisible: true, url: 'https://a' },
        { category: 'required', participantVisible: true },
        { category: 'referenced', participantVisible: true, url: 'https://b' },
        { category: 'suggested', participantVisible: true }
      ]
    }

    expect(computeResourceSummary(conversation)).toEqual({
      total: 4,
      required: 2,
      referenced: 1,
      suggested: 1,
      withLinks: 2
    })
  })

  it('excludes resources that participants could not see', () => {
    const conversation = {
      resources: [
        { category: 'required', participantVisible: true, url: 'https://a' },
        { category: 'referenced', participantVisible: false, url: 'https://b' }
      ]
    }

    expect(computeResourceSummary(conversation)).toEqual({
      total: 1,
      required: 1,
      referenced: 0,
      suggested: 0,
      withLinks: 1
    })
  })

  it('returns zeros when the event has no resources', () => {
    expect(computeResourceSummary({})).toEqual({ total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 })
  })
})

describe('deriveEventPlatform', () => {
  it('reports both when the event ran on Nextspace and Zoom', () => {
    expect(deriveEventPlatform({ platforms: ['nextspace', 'zoom'] })).toBe('both')
  })

  it('reports zoom for a Zoom-only event', () => {
    expect(deriveEventPlatform({ platforms: ['zoom'] })).toBe('zoom')
  })

  it('reports nextspace for a Nextspace-only event', () => {
    expect(deriveEventPlatform({ platforms: ['nextspace'] })).toBe('nextspace')
  })

  it('defaults to nextspace when no platform is recorded', () => {
    expect(deriveEventPlatform({})).toBe('nextspace')
  })
})

describe('computeConversationMetrics resources and platform', () => {
  it('includes the visible resource summary and the event platform in the metrics', async () => {
    const conversation = await Conversation.create({
      name: 'Readings event',
      slug: `readings-${new mongoose.Types.ObjectId().toString()}`,
      owner: ownerId,
      topic: new mongoose.Types.ObjectId(),
      transcript: { status: 'stopped' },
      platforms: ['nextspace', 'zoom'],
      resources: [
        { source: 'speaker', category: 'required', title: 'Required one', url: 'https://a', participantVisible: true },
        { source: 'ai', category: 'suggested', title: 'Suggested one', participantVisible: true },
        { source: 'speaker', category: 'referenced', title: 'Hidden ref', url: 'https://b', participantVisible: false }
      ]
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // The hidden referenced resource drops out, so only the two visible ones count.
    expect(metrics.resourceSummary).toEqual({ total: 2, required: 1, referenced: 0, suggested: 1, withLinks: 1 })
    expect(metrics.eventPlatform).toBe('both')
  })
})

/* Seeds one chat message with the given body. Defaults to a participant message in
   the chat channel, where bot invocations happen. */
async function seedChatMessage(
  conversationId: mongoose.Types.ObjectId,
  body: string,
  options: { fromAgent?: boolean; channels?: string[]; visible?: boolean } = {}
) {
  const { fromAgent = false, channels = ['chat'], visible = true } = options
  await Message.create([
    {
      body,
      conversation: conversationId,
      owner: ownerId,
      pseudonymId: ownerId,
      pseudonym: 'ana',
      fromAgent,
      channels,
      visible
    }
  ])
}

describe('computeConversationMetrics bot invocations', () => {
  it('counts participant chat messages that address the configured bot name', async () => {
    const conversation = await Conversation.create({
      name: 'Bot invocations event',
      slug: `bot-${new mongoose.Types.ObjectId().toString()}`,
      owner: ownerId,
      topic: new mongoose.Types.ObjectId(),
      properties: { botName: 'Athena' },
      transcript: { status: 'stopped' }
    })

    await seedChatMessage(conversation._id, 'hey @Athena what did I miss?')
    await seedChatMessage(conversation._id, 'athena, can you summarize?')
    await seedChatMessage(conversation._id, 'athna are you there') // misspelling, fuzzy match
    await seedChatMessage(conversation._id, 'this talk is great') // no mention
    await seedChatMessage(conversation._id, 'good one Athena', { fromAgent: true }) // bot's own message
    await seedChatMessage(conversation._id, 'ask Athena later', { channels: ['transcript'] }) // not chat

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.botInvocations).toEqual({ botName: 'Athena', count: 3 })
  })

  it('does not count a hidden chat message naming the bot, but counts a visible one', async () => {
    const conversation = await Conversation.create({
      name: 'Hidden invocation event',
      slug: `bot-${new mongoose.Types.ObjectId().toString()}`,
      owner: ownerId,
      topic: new mongoose.Types.ObjectId(),
      properties: { botName: 'Athena' },
      transcript: { status: 'stopped' }
    })

    await seedChatMessage(conversation._id, 'hey Athena are you there', { visible: true })
    await seedChatMessage(conversation._id, 'Athena can you help', { visible: false }) // hidden, excluded

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // Only the visible mention counts; the hidden one is dropped like every other human count.
    expect(metrics.botInvocations).toEqual({ botName: 'Athena', count: 1 })
  })

  it('falls back to the default bot name when the event configured none', async () => {
    const conversation = await Conversation.create({
      name: 'Default bot event',
      slug: `bot-${new mongoose.Types.ObjectId().toString()}`,
      owner: ownerId,
      topic: new mongoose.Types.ObjectId(),
      transcript: { status: 'stopped' }
    })

    await seedChatMessage(conversation._id, `${config.conversationBotName} what is the agenda?`)
    await seedChatMessage(conversation._id, 'no mention here')

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.botInvocations.botName).toBe(config.conversationBotName)
    expect(metrics.botInvocations.count).toBe(1)
  })
})

/* Creates a past event in a topic: one message from each name in `speakers` (a
   pseudonym is a poster's anonymous display name), so posterCount = speakers.length.
   When `tracked` is given, also stores a web-analytics snapshot so the event has a
   participant (visitor) count and dwell time; without it the event has no tracked
   data, so its lurker count is unknown (null). */
async function seedTopicEvent(
  topicId: mongoose.Types.ObjectId,
  options: {
    endTime?: Date
    speakers: string[]
    experimental?: boolean
    tracked?: { attendeeCount: number; totalVisits: number; totalDwellSeconds: number }
  }
) {
  const conversation = await Conversation.create({
    name: 'Topic series event',
    slug: `series-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: topicId,
    endTime: options.endTime,
    experimental: options.experimental ?? false,
    transcript: { status: 'stopped' }
  })
  if (options.speakers.length > 0) {
    await Message.create(
      options.speakers.map((pseudonym) => ({
        body: 'm',
        conversation: conversation._id,
        owner: ownerFor(pseudonym),
        pseudonymId: ownerId,
        pseudonym,
        fromAgent: false
      }))
    )
  }
  if (options.tracked) {
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: options.tracked.attendeeCount,
      totalVisits: options.tracked.totalVisits,
      totalActions: 0,
      totalDwellSeconds: options.tracked.totalDwellSeconds,
      deviceBreakdown: {},
      source: 'matomo',
      capturedAt: options.endTime ?? new Date('2026-06-12T00:00:00.000Z')
    })
  }
  return conversation
}

describe('computeConversationMetrics channel split', () => {
  it('counts private-to-bot messages separately from public chat', async () => {
    const conversation = await makeConversation()
    const agentId = new mongoose.Types.ObjectId()
    const directChannel = await Channel.create({
      name: `dm-${new mongoose.Types.ObjectId().toString()}`,
      direct: true,
      participants: [new mongoose.Types.ObjectId(), agentId]
    })
    await Message.create([
      {
        body: 'q1',
        conversation: conversation._id,
        owner: ownerFor('ana'),
        pseudonymId: ownerId,
        pseudonym: 'ana',
        fromAgent: false,
        channels: [directChannel.name]
      },
      {
        body: 'q2',
        conversation: conversation._id,
        owner: ownerFor('ana'),
        pseudonymId: ownerId,
        pseudonym: 'ana',
        fromAgent: false,
        channels: [directChannel.name]
      },
      {
        body: 'p1',
        conversation: conversation._id,
        owner: ownerFor('bo'),
        pseudonymId: ownerId,
        pseudonym: 'bo',
        fromAgent: false,
        channels: ['main']
      },
      {
        body: 'p2',
        conversation: conversation._id,
        owner: ownerFor('bo'),
        pseudonymId: ownerId,
        pseudonym: 'bo',
        fromAgent: false,
        channels: ['main']
      },
      {
        body: 'p3',
        conversation: conversation._id,
        owner: ownerFor('cy'),
        pseudonymId: ownerId,
        pseudonym: 'cy',
        fromAgent: false,
        channels: ['main']
      }
    ])

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.channelSplit).toEqual({ public: 3, private: 2 })
  })
})

/* The talk transcript is saved as non-agent messages on the 'transcript' channel.
   These are the speaker's words, not live chat, so they should not count toward
   participation, the channel split, or the activity series. Here 'speaker' posts five
   transcript lines and 'jen' sends three real chat messages, so only jen should register. */
async function seedChatAndTranscript(conversationId: mongoose.Types.ObjectId) {
  await Message.create([
    ...Array.from({ length: 5 }, () => ({
      body: 'spoken line',
      conversation: conversationId,
      owner: ownerFor('speaker'),
      pseudonymId: ownerId,
      pseudonym: 'speaker',
      fromAgent: false,
      channels: ['transcript']
    })),
    ...Array.from({ length: 3 }, () => ({
      body: 'chat line',
      conversation: conversationId,
      owner: ownerFor('jen'),
      pseudonymId: ownerId,
      pseudonym: 'jen',
      fromAgent: false,
      channels: ['main']
    }))
  ])
}

describe('computeConversationMetrics transcript exclusion', () => {
  it('excludes transcript-channel messages from participation, channel split, and activity', async () => {
    const conversation = await makeConversation()
    await seedChatAndTranscript(conversation._id)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // One poster is below the frequent-poster floor, so no dominance share is reported.
    expect(metrics.participation).toMatchObject({ posterCount: 1, frequentPosterCount: 0, messageCount: 3 })
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
    expect(metrics.channelSplit).toEqual({ public: 3, private: 0 })
    expect(metrics.activitySeries.reduce((sum, bucket) => sum + bucket.messageCount, 0)).toBe(3)
  })
})

/* Seeds three visible chat messages from 'mara' plus one hidden (visible:false)
   message from a distinct person 'ghost'. A hidden message is a backchannel/hidden
   entry that the canonical human-message count excludes, so only the three visible
   messages from the one visible poster should register. */
async function seedVisibleAndHidden(conversationId: mongoose.Types.ObjectId) {
  await Message.create([
    ...Array.from({ length: 3 }, () => ({
      body: 'chat line',
      conversation: conversationId,
      owner: ownerFor('mara'),
      pseudonymId: ownerId,
      pseudonym: 'mara',
      fromAgent: false,
      visible: true,
      channels: ['main']
    })),
    {
      body: 'hidden line',
      conversation: conversationId,
      owner: ownerFor('ghost'),
      pseudonymId: ownerId,
      pseudonym: 'ghost',
      fromAgent: false,
      visible: false,
      channels: ['main']
    }
  ])
}

describe('computeConversationMetrics hidden message exclusion', () => {
  it('excludes visible:false human messages from posters, message count, channel split, and activity', async () => {
    const conversation = await makeConversation()
    await seedVisibleAndHidden(conversation._id)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // Only 'mara' and her three visible messages count; 'ghost' and the hidden message drop out.
    expect(metrics.participation).toMatchObject({ posterCount: 1, frequentPosterCount: 0, messageCount: 3 })
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
    expect(metrics.channelSplit).toEqual({ public: 3, private: 0 })
    expect(metrics.activitySeries.reduce((sum, bucket) => sum + bucket.messageCount, 0)).toBe(3)
  })
})

describe('computeConversationMetrics history and baseline', () => {
  it('builds poster/lurker history and averages past same-topic events', async () => {
    const topicId = new mongoose.Types.ObjectId()
    await seedTopicEvent(topicId, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      speakers: ['a', 'b', 'c', 'd', 'e'], // 5 posters
      tracked: { attendeeCount: 20, totalVisits: 20, totalDwellSeconds: 24000 } // 15 lurkers, dwell 1200
    })
    await seedTopicEvent(topicId, {
      endTime: new Date('2026-06-08T12:00:00.000Z'),
      speakers: ['a', 'b', 'c', 'd', 'e', 'f'] // 6 posters, no tracked data -> lurker unknown
    })
    const current = await seedTopicEvent(topicId, {
      speakers: ['a', 'b'], // 2 posters
      tracked: { attendeeCount: 10, totalVisits: 10, totalDwellSeconds: 5000 } // 8 lurkers
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    expect(metrics.participationHistory).toEqual([
      { label: 'Topic series event (Jun 1)', posterCount: 5, lurkerCount: 15 },
      { label: 'Topic series event (Jun 8)', posterCount: 6, lurkerCount: null },
      { label: 'Today', posterCount: 2, lurkerCount: 8 }
    ])
    expect(metrics.baseline).toEqual({
      eventCount: 2,
      trackedEventCount: 1,
      avgPosterCount: 5.5,
      avgLurkerCount: 15,
      avgDwellSeconds: 1200
    })
  })

  it('excludes a tracked past event from both averages when posters exceed tracked sessions', async () => {
    const topicId = new mongoose.Types.ObjectId()
    // Reconciling tracked event: 5 posters, 20 tracked visitors -> 15 lurkers, dwell 1200.
    await seedTopicEvent(topicId, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      speakers: ['a', 'b', 'c', 'd', 'e'],
      tracked: { attendeeCount: 20, totalVisits: 20, totalDwellSeconds: 24000 }
    })
    // Non-reconciling tracked event: 5 posters but only 2 tracked visitors. Tracking
    // under-captured the audience, so it is not an honest lurker or dwell comparison and
    // must not fold a fake "0 lurkers" into either average.
    await seedTopicEvent(topicId, {
      endTime: new Date('2026-06-08T12:00:00.000Z'),
      speakers: ['a', 'b', 'c', 'd', 'e'],
      tracked: { attendeeCount: 2, totalVisits: 2, totalDwellSeconds: 600 }
    })
    const current = await seedTopicEvent(topicId, {
      speakers: ['a', 'b'],
      tracked: { attendeeCount: 10, totalVisits: 10, totalDwellSeconds: 5000 } // 8 lurkers
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    expect(metrics.participationHistory).toEqual([
      { label: 'Topic series event (Jun 1)', posterCount: 5, lurkerCount: 15 },
      { label: 'Topic series event (Jun 8)', posterCount: 5, lurkerCount: null },
      { label: 'Today', posterCount: 2, lurkerCount: 8 }
    ])
    expect(metrics.baseline).toEqual({
      eventCount: 2,
      trackedEventCount: 1,
      avgPosterCount: 5,
      avgLurkerCount: 15,
      avgDwellSeconds: 1200
    })
  })

  it('excludes an experimental past event in the same topic from the baseline and history', async () => {
    const topicId = new mongoose.Types.ObjectId()
    // Normal past event: 5 posters, 20 tracked visitors -> 15 lurkers, dwell 1200.
    await seedTopicEvent(topicId, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      speakers: ['a', 'b', 'c', 'd', 'e'],
      tracked: { attendeeCount: 20, totalVisits: 20, totalDwellSeconds: 24000 }
    })
    // Experimental past event (a test run) in the same topic. It ended and would otherwise
    // pollute the baseline, but experimental events must not count toward real-event averages.
    await seedTopicEvent(topicId, {
      endTime: new Date('2026-06-08T12:00:00.000Z'),
      speakers: ['x', 'y', 'z', 'w', 'v', 'u', 't'], // 7 posters, would skew avgPosterCount if counted
      experimental: true,
      tracked: { attendeeCount: 50, totalVisits: 50, totalDwellSeconds: 60000 }
    })
    const current = await seedTopicEvent(topicId, {
      speakers: ['a', 'b'],
      tracked: { attendeeCount: 10, totalVisits: 10, totalDwellSeconds: 5000 } // 8 lurkers
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    // Only the one normal past event appears, labeled by name and date; the experimental event is absent.
    expect(metrics.participationHistory).toEqual([
      { label: 'Topic series event (Jun 1)', posterCount: 5, lurkerCount: 15 },
      { label: 'Today', posterCount: 2, lurkerCount: 8 }
    ])
    expect(metrics.baseline).toEqual({
      eventCount: 1,
      trackedEventCount: 1,
      avgPosterCount: 5,
      avgLurkerCount: 15,
      avgDwellSeconds: 1200
    })
  })

  it('returns a null baseline when the topic has only this event', async () => {
    const topicId = new mongoose.Types.ObjectId()
    const only = await seedTopicEvent(topicId, { speakers: ['a', 'b'] }) // 2 posters, no tracked data

    const metrics = await conversationAnalyticsService.computeConversationMetrics(only)

    expect(metrics.baseline).toBeNull()
    expect(metrics.participationHistory).toEqual([{ label: 'Today', posterCount: 2, lurkerCount: null }])
  })
})
