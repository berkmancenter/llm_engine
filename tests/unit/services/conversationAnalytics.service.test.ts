import mongoose from 'mongoose'
import setupIntTest from '../../utils/setupIntTest.js'
import {
  Conversation,
  Message,
  ConversationAnalytics,
  ConversationMetricsSnapshot,
  Channel,
  Agent,
  Topic
} from '../../../src/models/index.js'
import conversationAnalyticsService, {
  attendanceBandFor,
  attributeSpikeSources,
  computeInteractionStructure,
  computeMessageLengthStats,
  computeParticipationConcentration,
  computeReplyLatency,
  computeResourceSummary,
  computeTimeToFirstMessage,
  computeTopDeviations,
  countMessageActivity,
  deriveEventPlatform,
  filterEventMessages,
  loadMessagesForOnDemandMetrics,
  spikeSourceForChannels,
  METRICS_VERSION
} from '../../../src/services/conversationAnalytics.service.js'
import { ChatSpike } from '../../../src/types/index.types.js'
import config from '../../../src/config/config.js'

setupIntTest()

const ownerId = new mongoose.Types.ObjectId()

/* Participation counts per person (owner) rather than per pseudonym, so every distinct persona in
   a fixture needs its own owner id or they collapse into one poster. This maps each pseudonym to a
   stable owner id, keeping a persona consistent across its messages while personas stay apart. */
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

/* Creates a real Agent document on the conversation, the same lightweight 'test' agentType
   fixture other test suites in this repo use. */
async function seedAgent(conversation) {
  const agent = new Agent({ agentType: 'vibesAnalyst', conversation })
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  return agent
}

/* Seeds one direct (1:1 bot-DM) channel between a person and an agent, the way joinConversation
   provisions one when someone connects (see conversation.service). Registers it on the
   conversation's own channels array, which is what the participant count reads: that list
   filtered to direct:true, minus the conversation's own agents. */
async function seedDirectChannel(conversation, agent) {
  const userId = new mongoose.Types.ObjectId()
  const channel = await Channel.create({
    name: `direct-${userId.toString()}-${agent._id.toString()}`,
    direct: true,
    participants: [userId, agent._id]
  })
  conversation.channels.push(channel)
  await conversation.save()
  return userId
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
    // audienceEngagement no longer reads Matomo; seed 40 direct-channel participants so the
    // headcount still reconciles with the tracked-session assertions below.
    const agent = await seedAgent(conversation)
    for (let i = 0; i < 40; i += 1) await seedDirectChannel(conversation, agent)

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
    // An older snapshot stored before action tracking existed has no breakdown or
    // activeVisitorCount, so they coerce to empty/zero and the averages stay empty.
    expect(matomo.actionBreakdown).toEqual({})
    expect(matomo.actionUserBreakdown).toEqual({})
    expect(matomo.activeVisitorCount).toBe(0)
    expect(matomo.actionBreakdownPerActiveVisitor).toEqual({})
  })

  it('derives per-active-visitor action averages from the stored action breakdown', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id)
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      attendeeCount: 40,
      totalVisits: 100,
      totalActions: 800,
      totalDwellSeconds: 30000,
      deviceBreakdown: { desktop: 70, mobile: 30 },
      actionBreakdown: { 'command:visual': 20, 'tab:chat': 10 },
      actionUserBreakdown: { 'command:visual': 4, 'tab:chat': 3 },
      activeVisitorCount: 5,
      source: 'matomo',
      capturedAt: new Date('2026-06-12T00:00:00.000Z')
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
    const [matomo] = metrics.trackedSessionSources

    expect(matomo.actionBreakdown).toEqual({ 'command:visual': 20, 'tab:chat': 10 })
    expect(matomo.actionUserBreakdown).toEqual({ 'command:visual': 4, 'tab:chat': 3 })
    expect(matomo.activeVisitorCount).toBe(5)
    // Averages are per active visitor (the Bucket-1 denominator), computed at read time.
    expect(matomo.actionBreakdownPerActiveVisitor).toEqual({ 'command:visual': 4, 'tab:chat': 2 })
  })

  it('returns the participant mismatch and no tracked sessions when no source is referenced or stored', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id) // 2 posters, but nobody joined via a direct channel

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.participation).toMatchObject({ posterCount: 2, frequentPosterCount: 0, messageCount: 3 })
    expect(metrics.participation.frequentPosterMessageShare).toBeNull()
    expect(metrics.audienceEngagement).toEqual({
      participantCount: 0,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    })
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
  it('counts zero participants and reports an empty room when the conversation has no direct channels', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id) // 2 posters, but nobody ever joined via a channel

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    // 2 posters against 0 participants is the mismatch case (posters cannot exceed
    // an empty room's headcount without invention), not the true "empty room" case.
    expect(metrics.audienceEngagement).toEqual({
      participantCount: 0,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    })
  })

  it('returns null lurkers and rate and flags the mismatch when posters exceed direct-channel participants', async () => {
    const conversation = await makeConversation()
    await seedParticipation(conversation._id) // 2 posters
    const agent = await seedAgent(conversation)
    await seedDirectChannel(conversation, agent) // 1 participant joined

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
    const agent = await seedAgent(conversation)
    for (let i = 0; i < 5; i += 1) await seedDirectChannel(conversation, agent)

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.audienceEngagement).toEqual({
      participantCount: 5,
      lurkerCount: 3,
      participationRate: 0.4,
      postersExceedTrackedSessions: false
    })
  })

  it('counts each distinct person once even when the conversation has more than one agent', async () => {
    // joinConversation provisions one direct channel per agent for every person who joins, so a
    // conversation with 2 agents gives each attendee 2 direct channels. The headcount must dedupe
    // by person, not by channel row, or it would silently double an otherwise-correct count.
    const conversation = await makeConversation()
    await seedParticipation(conversation._id) // 2 posters
    const agentOne = await seedAgent(conversation)
    const agentTwo = await seedAgent(conversation)
    const userId = new mongoose.Types.ObjectId()
    for (const agent of [agentOne, agentTwo]) {
      const channel = await Channel.create({
        name: `direct-${userId.toString()}-${agent._id.toString()}`,
        direct: true,
        participants: [userId, agent._id]
      })
      conversation.channels.push(channel)
    }
    await conversation.save()

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.audienceEngagement?.participantCount).toBe(1)
  })

  it('ignores a non-direct channel on the conversation, since it carries no one-to-one participant', async () => {
    const conversation = await makeConversation()
    const publicChannel = await Channel.create({ name: 'main', direct: false })
    conversation.channels.push(publicChannel)
    await conversation.save()

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.audienceEngagement?.participantCount).toBe(0)
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

describe('computeTimeToFirstMessage', () => {
  const start = new Date('2026-06-10T10:00:00.000Z')
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60 * 1000)
  const directNames = new Set(['dm-1'])

  it('measures seconds from event start to the first message on each surface', () => {
    const messages = [
      { createdAt: at(3), channels: ['chat'] },
      { createdAt: at(5), channels: ['chat'] },
      { createdAt: at(1), channels: ['dm-1'] },
      { createdAt: at(4), channels: ['dm-1'] }
    ]

    expect(computeTimeToFirstMessage(messages, directNames, start)).toEqual({
      publicSeconds: 180,
      privateSeconds: 60
    })
  })

  it('treats a message with no channel as the public group chat', () => {
    const messages = [{ createdAt: at(2), channels: undefined }]

    expect(computeTimeToFirstMessage(messages, directNames, start)).toEqual({
      publicSeconds: 120,
      privateSeconds: null
    })
  })

  it('returns null for a surface with no human message', () => {
    const messages = [{ createdAt: at(2), channels: ['chat'] }]

    expect(computeTimeToFirstMessage(messages, directNames, start)).toEqual({
      publicSeconds: 120,
      privateSeconds: null
    })
  })

  it('clamps a message sent before the event start to zero', () => {
    const messages = [{ createdAt: at(-2), channels: ['chat'] }]

    expect(computeTimeToFirstMessage(messages, directNames, start)).toEqual({
      publicSeconds: 0,
      privateSeconds: null
    })
  })

  it('returns null on both surfaces when the event start is unknown', () => {
    const messages = [{ createdAt: at(3), channels: ['chat'] }]

    expect(computeTimeToFirstMessage(messages, directNames, undefined)).toEqual({
      publicSeconds: null,
      privateSeconds: null
    })
  })

  it('ignores messages that carry no timestamp', () => {
    const messages = [{ channels: ['chat'] }, { createdAt: at(4), channels: ['chat'] }]

    expect(computeTimeToFirstMessage(messages, directNames, start)).toEqual({
      publicSeconds: 240,
      privateSeconds: null
    })
  })
})

describe('computeReplyLatency', () => {
  const start = new Date('2026-06-10T10:00:00.000Z')
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60 * 1000)

  it("takes the median gap to each replied-to message's first reply", () => {
    const messages = [
      { _id: 'a', createdAt: at(0) },
      { _id: 'b', createdAt: at(2), parentMessage: 'a' }, // first reply to a: 2 min
      { _id: 'c', createdAt: at(5), parentMessage: 'a' }, // later reply to a, ignored
      { _id: 'd', createdAt: at(1) },
      { _id: 'e', createdAt: at(4), parentMessage: 'd' } // first reply to d: 3 min
    ]

    expect(computeReplyLatency(messages)).toEqual({
      medianSecondsToFirstReply: 150, // median of 120s and 180s
      repliedMessageCount: 2
    })
  })

  it('takes the middle value for an odd number of replied-to messages', () => {
    const messages = [
      { _id: 'a', createdAt: at(0) },
      { _id: 'b', createdAt: at(1), parentMessage: 'a' }, // 60s
      { _id: 'c', createdAt: at(10) },
      { _id: 'd', createdAt: at(12), parentMessage: 'c' }, // 120s
      { _id: 'e', createdAt: at(20) },
      { _id: 'f', createdAt: at(25), parentMessage: 'e' } // 300s
    ]

    expect(computeReplyLatency(messages)).toEqual({
      medianSecondsToFirstReply: 120,
      repliedMessageCount: 3
    })
  })

  it('uses the earliest reply regardless of message order', () => {
    const messages = [
      { _id: 'a', createdAt: at(0) },
      { _id: 'c', createdAt: at(5), parentMessage: 'a' }, // out of order, later
      { _id: 'b', createdAt: at(1), parentMessage: 'a' } // earliest reply: 60s
    ]

    expect(computeReplyLatency(messages)).toEqual({
      medianSecondsToFirstReply: 60,
      repliedMessageCount: 1
    })
  })

  it('ignores a reply whose parent is not in the human message set', () => {
    const messages = [
      { _id: 'a', createdAt: at(0) },
      { _id: 'b', createdAt: at(2), parentMessage: 'bot-msg' } // parent absent (e.g. a bot reply)
    ]

    expect(computeReplyLatency(messages)).toEqual({
      medianSecondsToFirstReply: null,
      repliedMessageCount: 0
    })
  })

  it('returns a null median and zero count when nothing was a reply', () => {
    const messages = [
      { _id: 'a', createdAt: at(0) },
      { _id: 'b', createdAt: at(2) }
    ]

    expect(computeReplyLatency(messages)).toEqual({
      medianSecondsToFirstReply: null,
      repliedMessageCount: 0
    })
  })
})

describe('computeParticipationConcentration', () => {
  const posts = (owner: string, count: number) => Array.from({ length: count }, () => ({ owner }))

  it('reports the top-few share and the one-time vs repeat split', () => {
    const messages = [...posts('p1', 4), ...posts('p2', 3), ...posts('p3', 2), ...posts('p4', 2), ...posts('p5', 1)]

    expect(computeParticipationConcentration(messages)).toEqual({
      topPosterCount: 3,
      topPosterMessageShare: 0.75, // top 3 sent 9 of 12 messages
      oneTimePosterCount: 1,
      repeatPosterCount: 4
    })
  })

  it('nulls the share below a handful of posters but still splits one-time from repeat', () => {
    const messages = [...posts('a', 3), ...posts('b', 2), ...posts('c', 1), ...posts('d', 1)]

    expect(computeParticipationConcentration(messages)).toEqual({
      topPosterCount: 3,
      topPosterMessageShare: null,
      oneTimePosterCount: 2,
      repeatPosterCount: 2
    })
  })

  it('caps the top count at the poster count when fewer than a few posted', () => {
    const messages = [...posts('a', 2), ...posts('b', 1)]

    expect(computeParticipationConcentration(messages)).toEqual({
      topPosterCount: 2,
      topPosterMessageShare: null,
      oneTimePosterCount: 1,
      repeatPosterCount: 1
    })
  })

  it('returns zeros and a null share when no one posted', () => {
    expect(computeParticipationConcentration([])).toEqual({
      topPosterCount: 0,
      topPosterMessageShare: null,
      oneTimePosterCount: 0,
      repeatPosterCount: 0
    })
  })

  it('groups by pseudonymId when there is no owner and drops a message with neither', () => {
    const messages = [{}, { pseudonymId: 'x' }, { pseudonymId: 'x' }, { owner: 'y' }]

    expect(computeParticipationConcentration(messages)).toEqual({
      topPosterCount: 2,
      topPosterMessageShare: null,
      oneTimePosterCount: 1,
      repeatPosterCount: 1
    })
  })
})

describe('computeInteractionStructure', () => {
  it('measures thread size and reply depth for a nested thread', () => {
    const messages = [
      { _id: 'a' },
      { _id: 'b', parentMessage: 'a' },
      { _id: 'c', parentMessage: 'a' },
      { _id: 'd', parentMessage: 'b' } // deepest chain: a -> b -> d
    ]

    expect(computeInteractionStructure(messages)).toEqual({
      threadCount: 1,
      maxThreadSize: 4,
      medianThreadSize: 4,
      maxReplyDepth: 2
    })
  })

  it('counts across threads and ignores a lone unanswered message', () => {
    const messages = [
      { _id: 'a' },
      { _id: 'b', parentMessage: 'a' }, // thread 1: size 2, depth 1
      { _id: 'c' },
      { _id: 'd', parentMessage: 'c' },
      { _id: 'e', parentMessage: 'd' }, // thread 2: size 3, depth 2
      { _id: 'f' } // lone root, no replies
    ]

    expect(computeInteractionStructure(messages)).toEqual({
      threadCount: 2,
      maxThreadSize: 3,
      medianThreadSize: 2.5, // median of [3, 2]
      maxReplyDepth: 2
    })
  })

  it('treats a reply whose parent is outside the human set as its own thread root', () => {
    const messages = [
      { _id: 'a', parentMessage: 'bot-msg' }, // parent absent, so a starts a thread
      { _id: 'b', parentMessage: 'a' }
    ]

    expect(computeInteractionStructure(messages)).toEqual({
      threadCount: 1,
      maxThreadSize: 2,
      medianThreadSize: 2,
      maxReplyDepth: 1
    })
  })

  it('returns zeros and a null median when nothing was threaded', () => {
    const messages = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]

    expect(computeInteractionStructure(messages)).toEqual({
      threadCount: 0,
      maxThreadSize: 0,
      medianThreadSize: null,
      maxReplyDepth: 0
    })
  })

  it('returns zeros and a null median for no messages', () => {
    expect(computeInteractionStructure([])).toEqual({
      threadCount: 0,
      maxThreadSize: 0,
      medianThreadSize: null,
      maxReplyDepth: 0
    })
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

/* Creates a past event in a topic: one message per name in `speakers`, so posterCount =
   speakers.length. `tracked` stores the web-analytics snapshot and seeds one direct channel per
   `attendeeCount`, since the audience headcount reads from direct channels (see
   countChannelParticipants). Without it the event has no channels, so its lurker count is null. */
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
    const agent = await seedAgent(conversation)
    for (let i = 0; i < options.tracked.attendeeCount; i += 1) await seedDirectChannel(conversation, agent)
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
    // ana sent both private messages; bo and cy posted publicly. posterCount is 3.
    expect(metrics.privateMessaging).toEqual({
      privateMessageCount: 2,
      distinctPrivateSenders: 1,
      distinctPublicSenders: 2,
      avgPrivateMessagesPerPoster: 2 / 3
    })
  })

  it('reports zero distinct private senders and a zero average when no private messages were sent', async () => {
    const conversation = await makeConversation()
    await Message.create([
      {
        body: 'hi',
        conversation: conversation._id,
        owner: ownerFor('ana'),
        pseudonymId: ownerId,
        pseudonym: 'ana',
        fromAgent: false,
        channels: ['main']
      }
    ])

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)

    expect(metrics.privateMessaging).toEqual({
      privateMessageCount: 0,
      distinctPrivateSenders: 0,
      distinctPublicSenders: 1,
      avgPrivateMessagesPerPoster: 0
    })
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

/* Seeds one past event as a persisted metrics snapshot, the source of truth history and the
   baseline now read from. lurkerCount null marks an event whose tracking did not reconcile
   (or had no tracked data), so it contributes a poster count but no lurker or dwell sample,
   exactly as the snapshot would have been written. */
async function seedPastSnapshot(
  topicId: mongoose.Types.ObjectId,
  options: {
    endTime: Date
    posterCount: number
    lurkerCount: number | null
    avgDwellSeconds?: number | null
    metricsVersion?: number
  }
) {
  return ConversationMetricsSnapshot.create({
    conversationId: new mongoose.Types.ObjectId(),
    topicId,
    name: 'Topic series event',
    endTime: options.endTime,
    platform: 'nextspace',
    metricsVersion: options.metricsVersion ?? METRICS_VERSION,
    capturedAt: options.endTime,
    posterCount: options.posterCount,
    messageCount: options.posterCount,
    frequentPosterCount: 0,
    frequentPosterMessageShare: null,
    trackedSessionStatus: options.lurkerCount !== null ? 'available' : 'notTracked',
    trackedSessions: 0,
    participantCount: options.lurkerCount !== null ? options.posterCount + options.lurkerCount : null,
    lurkerCount: options.lurkerCount,
    participationRate: null,
    postersExceedTrackedSessions: options.lurkerCount === null ? null : false,
    avgDwellSeconds: options.avgDwellSeconds ?? null,
    totalActions: null,
    channelSplit: { public: 0, private: 0 },
    botInvocationCount: 0,
    resourceSummary: { total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 },
    spikeCount: 0,
    receptionCount: null
  })
}

describe('computeConversationMetrics history and baseline', () => {
  it('reads past events from their snapshots and averages them, recomputing only today', async () => {
    const topicId = new mongoose.Types.ObjectId()
    // Past events carry no messages here, only snapshots: if history still recomputed from raw
    // messages these would read as 0 posters, so the 5 and 6 below prove it reads the snapshot.
    await seedPastSnapshot(topicId, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 5,
      lurkerCount: 15,
      avgDwellSeconds: 1200
    })
    await seedPastSnapshot(topicId, {
      endTime: new Date('2026-06-08T12:00:00.000Z'),
      posterCount: 6,
      lurkerCount: null // no tracked data -> lurker unknown, left out of both averages
    })
    const current = await seedTopicEvent(topicId, {
      speakers: ['a', 'b'], // 2 posters, recomputed live from messages
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

  it('excludes a past snapshot with an unknown lurker count from both tracked averages', async () => {
    const topicId = new mongoose.Types.ObjectId()
    // Reconciled snapshot: 5 posters, 15 lurkers, dwell 1200.
    await seedPastSnapshot(topicId, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 5,
      lurkerCount: 15,
      avgDwellSeconds: 1200
    })
    // A snapshot whose tracking did not reconcile carries a null lurker count, so it must not
    // fold a fake "0 lurkers" or its dwell into either tracked average, though its poster
    // count still counts. avgDwellSeconds is present but ignored because the lurker count is null.
    await seedPastSnapshot(topicId, {
      endTime: new Date('2026-06-08T12:00:00.000Z'),
      posterCount: 5,
      lurkerCount: null,
      avgDwellSeconds: 300
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

  it('ignores snapshots stamped with a different metrics version', async () => {
    const topicId = new mongoose.Types.ObjectId()
    // Current-version snapshot that should count.
    await seedPastSnapshot(topicId, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 5,
      lurkerCount: 15,
      avgDwellSeconds: 1200
    })
    // An older-version snapshot whose metrics meant something different. Mixing it into the
    // average would compare unlike numbers, so the version filter must leave it out.
    await seedPastSnapshot(topicId, {
      endTime: new Date('2026-06-08T12:00:00.000Z'),
      posterCount: 99,
      lurkerCount: 99,
      avgDwellSeconds: 9999,
      metricsVersion: METRICS_VERSION + 1
    })
    const current = await seedTopicEvent(topicId, {
      speakers: ['a', 'b'],
      tracked: { attendeeCount: 10, totalVisits: 10, totalDwellSeconds: 5000 }
    })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    // Only the current-version past event appears; the other-version one is absent everywhere.
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

  it('returns a null baseline when the topic has no past snapshots', async () => {
    const topicId = new mongoose.Types.ObjectId()
    const only = await seedTopicEvent(topicId, { speakers: ['a', 'b'] }) // 2 posters, no tracked data

    const metrics = await conversationAnalyticsService.computeConversationMetrics(only)

    expect(metrics.baseline).toBeNull()
    expect(metrics.participationHistory).toEqual([{ label: 'Today', posterCount: 2, lurkerCount: null }])
  })
})

describe('attendanceBandFor', () => {
  it('buckets posterCount into tiny, small, medium, and large', () => {
    expect(attendanceBandFor(0)).toBe('tiny')
    expect(attendanceBandFor(9)).toBe('tiny')
    expect(attendanceBandFor(10)).toBe('small')
    expect(attendanceBandFor(24)).toBe('small')
    expect(attendanceBandFor(25)).toBe('medium')
    expect(attendanceBandFor(49)).toBe('medium')
    expect(attendanceBandFor(50)).toBe('large')
    expect(attendanceBandFor(200)).toBe('large')
  })
})

/* Seeds one public or private topic, so a peer-cohort test can prove the privacy filter
   actually excludes a private topic's events rather than just checking a query shape. */
async function seedTopic(overrides: { private: boolean }) {
  return Topic.create({
    name: `Peer cohort topic ${new mongoose.Types.ObjectId().toString()}`,
    slug: `peer-cohort-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    votingAllowed: false,
    conversationCreationAllowed: false,
    archivable: false,
    private: overrides.private
  })
}

/* Seeds one past peer event as a persisted snapshot plus the real Conversation/Topic documents
   behind it, since computePeerBaseline joins to Topic to enforce its public-only privacy gate
   (the same gate as summon), unlike the same-topic baseline which never needed one. */
async function seedPeerEvent(
  topicId: mongoose.Types.ObjectId,
  options: {
    endTime: Date
    posterCount: number
    platform?: 'nextspace' | 'zoom' | 'both'
    participationRate?: number | null
    topPosterMessageShare?: number | null
    metricsVersion?: number
  }
) {
  const conversation = await Conversation.create({
    name: 'Peer event',
    slug: `peer-${new mongoose.Types.ObjectId().toString()}`,
    owner: ownerId,
    topic: topicId,
    endTime: options.endTime,
    transcript: { status: 'stopped' }
  })
  await ConversationMetricsSnapshot.create({
    conversationId: conversation._id,
    topicId,
    name: 'Peer event',
    endTime: options.endTime,
    platform: options.platform ?? 'nextspace',
    metricsVersion: options.metricsVersion ?? METRICS_VERSION,
    capturedAt: options.endTime,
    posterCount: options.posterCount,
    messageCount: options.posterCount,
    frequentPosterCount: 0,
    frequentPosterMessageShare: null,
    trackedSessionStatus: 'notTracked',
    trackedSessions: null,
    participantCount: null,
    lurkerCount: null,
    participationRate: options.participationRate ?? null,
    postersExceedTrackedSessions: null,
    avgDwellSeconds: null,
    totalActions: null,
    channelSplit: { public: 0, private: 0 },
    botInvocationCount: 0,
    resourceSummary: { total: 0, required: 0, referenced: 0, suggested: 0, withLinks: 0 },
    spikeCount: 0,
    receptionCount: null,
    timeToFirstMessage: { publicSeconds: null, privateSeconds: null },
    replyLatency: { medianSecondsToFirstReply: null, repliedMessageCount: 0 },
    participationConcentration: {
      topPosterCount: 0,
      topPosterMessageShare: options.topPosterMessageShare ?? null,
      oneTimePosterCount: 0,
      repeatPosterCount: 0
    },
    interactionStructure: { threadCount: 0, maxThreadSize: 0, medianThreadSize: null, maxReplyDepth: 0 }
  })
  return conversation
}

describe('computeConversationMetrics peer baseline', () => {
  it('averages same-band, same-platform public peers, excluding the current event and its own topic', async () => {
    const publicTopic = await seedTopic({ private: false })
    // Same band (small: 10-24) and same platform as the live event below.
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 15,
      participationRate: 0.5,
      topPosterMessageShare: 0.4
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-02T12:00:00.000Z'),
      posterCount: 20,
      participationRate: 0.6,
      topPosterMessageShare: 0.6
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-03T12:00:00.000Z'),
      posterCount: 19,
      participationRate: 0.4,
      topPosterMessageShare: 0.5
    })
    // Different band (large): must not be pulled into a "small" cohort.
    await seedPeerEvent(publicTopic._id, { endTime: new Date('2026-06-04T12:00:00.000Z'), posterCount: 90 })

    const current = await seedTopicEvent(publicTopic._id, { speakers: Array.from({ length: 18 }, (_, i) => `p${i}`) })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    expect(metrics.peerBaseline).toEqual({
      band: 'small',
      eventCount: 3,
      avgPosterCount: 18,
      avgParticipationRate: 0.5,
      participationRateEventCount: 3,
      avgTopPosterMessageShare: 0.5,
      concentrationEventCount: 3
    })
  })

  it('excludes peer events from a private topic even when they match the band and platform', async () => {
    const publicTopic = await seedTopic({ private: false })
    const privateTopic = await seedTopic({ private: true })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 15,
      participationRate: 0.5
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-02T12:00:00.000Z'),
      posterCount: 16,
      participationRate: 0.5
    })
    // A private topic's events must never enter another topic's peer comparison, even though
    // their numbers would otherwise qualify (same band, same platform).
    await seedPeerEvent(privateTopic._id, {
      endTime: new Date('2026-06-03T12:00:00.000Z'),
      posterCount: 17,
      participationRate: 0.9
    })

    const current = await seedTopicEvent(publicTopic._id, { speakers: Array.from({ length: 18 }, (_, i) => `p${i}`) })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    // Below PEER_COHORT_MIN_EVENTS (3) once the private topic's event is excluded, so this
    // reports null rather than a thin, misleading average built from just 2 events.
    expect(metrics.peerBaseline).toBeNull()
  })

  it('only compares events on the same platform', async () => {
    const publicTopic = await seedTopic({ private: false })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 15,
      platform: 'zoom',
      participationRate: 0.9
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-02T12:00:00.000Z'),
      posterCount: 16,
      platform: 'zoom',
      participationRate: 0.9
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-03T12:00:00.000Z'),
      posterCount: 17,
      platform: 'zoom',
      participationRate: 0.9
    })

    // The live event runs on nextspace (seedTopicEvent's conversation carries no platforms, so
    // deriveEventPlatform defaults it to nextspace), so none of the zoom peers above should count.
    const current = await seedTopicEvent(publicTopic._id, { speakers: Array.from({ length: 18 }, (_, i) => `p${i}`) })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    expect(metrics.peerBaseline).toBeNull()
  })

  it('ignores peer snapshots stamped with a different metrics version', async () => {
    const publicTopic = await seedTopic({ private: false })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-01T12:00:00.000Z'),
      posterCount: 15,
      participationRate: 0.5
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-02T12:00:00.000Z'),
      posterCount: 16,
      participationRate: 0.5
    })
    await seedPeerEvent(publicTopic._id, {
      endTime: new Date('2026-06-03T12:00:00.000Z'),
      posterCount: 999,
      participationRate: 0.99,
      metricsVersion: METRICS_VERSION + 1
    })

    const current = await seedTopicEvent(publicTopic._id, { speakers: Array.from({ length: 18 }, (_, i) => `p${i}`) })

    const metrics = await conversationAnalyticsService.computeConversationMetrics(current)

    // Only 2 current-version peers qualify, below PEER_COHORT_MIN_EVENTS, so null.
    expect(metrics.peerBaseline).toBeNull()
  })
})

describe('computeTopDeviations', () => {
  const today = {
    posterCount: 40,
    participationRate: 0.5,
    topPosterMessageShare: 0.6,
    lurkerCount: 10,
    avgDwellSeconds: 300
  }

  it('returns an empty list when there is nothing to compare against', () => {
    expect(computeTopDeviations(today, null, null)).toEqual([])
  })

  it('ranks by size of percent difference, largest first', () => {
    const baseline = { eventCount: 4, trackedEventCount: 4, avgPosterCount: 38, avgLurkerCount: 9, avgDwellSeconds: 290 }
    const peerBaseline = {
      band: 'medium' as const,
      eventCount: 5,
      avgPosterCount: 30,
      avgParticipationRate: 0.4,
      participationRateEventCount: 5,
      avgTopPosterMessageShare: 0.2,
      concentrationEventCount: 5
    }

    const deviations = computeTopDeviations(today, baseline, peerBaseline)

    const magnitudes = deviations.map((d) => Math.abs(d.percentDifference))
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a))
    // topPosterMessageShare vs peers (0.6 vs 0.2, +200%) is the largest swing here.
    expect(deviations[0].metric).toBe('topPosterMessageShare')
    expect(deviations[0].comparison).toBe('peerBaseline')
    expect(deviations[0].direction).toBe('above')
  })

  it('omits a comparison whose average is null', () => {
    const peerBaseline = {
      band: 'medium' as const,
      eventCount: 5,
      avgPosterCount: 20,
      avgParticipationRate: null,
      participationRateEventCount: 0,
      avgTopPosterMessageShare: null,
      concentrationEventCount: 0
    }

    const deviations = computeTopDeviations(today, null, peerBaseline)

    expect(deviations.some((d) => d.metric === 'participationRate')).toBe(false)
    expect(deviations.some((d) => d.metric === 'topPosterMessageShare')).toBe(false)
    expect(deviations.some((d) => d.metric === 'posterCount' && d.comparison === 'peerBaseline')).toBe(true)
  })

  it('omits a comparison whose average is zero to avoid a divide-by-zero', () => {
    const baseline = { eventCount: 3, trackedEventCount: 3, avgPosterCount: 38, avgLurkerCount: 0, avgDwellSeconds: 290 }

    const deviations = computeTopDeviations(today, baseline, null)

    expect(deviations.some((d) => d.metric === 'lurkerCount')).toBe(false)
  })

  it('marks avgDwellSeconds as an estimate and every other metric as exact', () => {
    const baseline = { eventCount: 3, trackedEventCount: 3, avgPosterCount: 38, avgLurkerCount: 9, avgDwellSeconds: 100 }

    const deviations = computeTopDeviations(today, baseline, null)

    const dwell = deviations.find((d) => d.metric === 'avgDwellSeconds')
    const posters = deviations.find((d) => d.metric === 'posterCount')
    expect(dwell?.tier).toBe('estimate')
    expect(posters?.tier).toBe('exact')
  })

  it('caps the list at the top 5 deviations', () => {
    // All 6 possible comparisons qualify; avgPosterCount vs topicBaseline is the smallest
    // swing (40 vs 39, roughly +2.6%) and should be the one dropped.
    const baseline = { eventCount: 4, trackedEventCount: 4, avgPosterCount: 39, avgLurkerCount: 4, avgDwellSeconds: 100 }
    const peerBaseline = {
      band: 'medium' as const,
      eventCount: 5,
      avgPosterCount: 10,
      avgParticipationRate: 0.1,
      participationRateEventCount: 5,
      avgTopPosterMessageShare: 0.1,
      concentrationEventCount: 5
    }

    const deviations = computeTopDeviations(today, baseline, peerBaseline)

    expect(deviations).toHaveLength(5)
    expect(deviations.some((d) => d.metric === 'posterCount' && d.comparison === 'topicBaseline')).toBe(false)
  })
})

/* The on-demand computations all read the same slice-of-an-event filter, so these fixtures give
   an event start and a set of direct (one-to-one with the bot) channel names to resolve it
   against. Messages are placed by elapsed minute from that start. */
const onDemandStart = new Date('2026-07-01T12:00:00.000Z')
const directNames = new Set(['dm-ana', 'dm-bo'])

function atMinute(minute: number): Date {
  return new Date(onDemandStart.getTime() + minute * 60 * 1000)
}

/* One human message: who sent it, when, where, and what it said. Only the word count of `body`
   is ever read, never its text. */
function onDemandMessage(owner: string, minute: number, body = 'a message', channels: string[] = ['chat']) {
  return { owner, createdAt: atMinute(minute), channels, body }
}

describe('filterEventMessages', () => {
  it('keeps messages from the start minute up to but not including the end minute', () => {
    const messages = [
      onDemandMessage('ana', 0),
      onDemandMessage('ana', 5),
      onDemandMessage('bo', 10),
      onDemandMessage('bo', 20)
    ]

    const filtered = filterEventMessages(
      messages,
      { fromMinute: 5, toMinute: 20 },
      {
        startTime: onDemandStart,
        directNames
      }
    )

    expect(filtered.map((message) => message.createdAt)).toEqual([atMinute(5), atMinute(10)])
  })

  it('splits the public chat from private one-to-one messages with the bot', () => {
    const messages = [
      onDemandMessage('ana', 1, 'hi', ['chat']),
      onDemandMessage('ana', 2, 'psst', ['dm-ana']),
      onDemandMessage('bo', 3, 'hey', ['dm-bo'])
    ]
    const context = { startTime: onDemandStart, directNames }

    expect(filterEventMessages(messages, { channel: 'public' }, context)).toHaveLength(1)
    expect(filterEventMessages(messages, { channel: 'private' }, context)).toHaveLength(2)
    expect(filterEventMessages(messages, { channel: 'all' }, context)).toHaveLength(3)
  })

  it('keeps only messages of at least the requested word count', () => {
    const messages = [onDemandMessage('ana', 1, 'yes'), onDemandMessage('bo', 2, 'that is a much longer thought about it')]

    const filtered = filterEventMessages(messages, { minWordCount: 5 }, { startTime: onDemandStart, directNames })

    expect(filtered).toHaveLength(1)
    expect(filtered[0].owner).toBe('bo')
  })

  it('measures the window from the first message when the event start is unknown', () => {
    // No startTime, so minute 0 is the first message (at 12:10) rather than a real event start.
    const messages = [onDemandMessage('ana', 10), onDemandMessage('bo', 12), onDemandMessage('bo', 25)]

    const filtered = filterEventMessages(messages, { toMinute: 5 }, { directNames })

    expect(filtered.map((message) => message.owner)).toEqual(['ana', 'bo'])
  })

  it('returns every message when nothing is filtered', () => {
    const messages = [onDemandMessage('ana', 1), onDemandMessage('bo', 2)]

    expect(filterEventMessages(messages, {}, { startTime: onDemandStart, directNames })).toHaveLength(2)
  })

  it('drops a message with no timestamp only when a window is asked for', () => {
    const messages = [onDemandMessage('ana', 1), { owner: 'bo', channels: ['chat'], body: 'undated' }]
    const context = { startTime: onDemandStart, directNames }

    expect(filterEventMessages(messages, {}, context)).toHaveLength(2)
    expect(filterEventMessages(messages, { fromMinute: 0 }, context)).toHaveLength(1)
  })
})

describe('countMessageActivity', () => {
  const context = { startTime: onDemandStart, directNames }

  it('counts the messages in a window and how many different people sent them', () => {
    const messages = [
      onDemandMessage('ana', 1),
      onDemandMessage('ana', 2),
      onDemandMessage('bo', 3),
      onDemandMessage('cy', 40)
    ]

    expect(countMessageActivity(messages, { toMinute: 10 }, null, context)).toEqual({
      messageCount: 3,
      posterCount: 2,
      postersAtOrAboveThreshold: null
    })
  })

  it('reports how many posters cleared a message threshold', () => {
    const messages = [
      onDemandMessage('ana', 1),
      onDemandMessage('ana', 2),
      onDemandMessage('ana', 3),
      onDemandMessage('bo', 4),
      onDemandMessage('bo', 5),
      onDemandMessage('cy', 6)
    ]

    expect(countMessageActivity(messages, {}, 2, context).postersAtOrAboveThreshold).toBe(2)
  })

  it('counts only the people inside the filtered slice', () => {
    const messages = [onDemandMessage('ana', 1, 'hi', ['dm-ana']), onDemandMessage('bo', 2)]

    expect(countMessageActivity(messages, { channel: 'private' }, null, context).posterCount).toBe(1)
  })

  it('reports zeros when nothing matches the filter', () => {
    expect(countMessageActivity([onDemandMessage('ana', 1)], { fromMinute: 30 }, 3, context)).toEqual({
      messageCount: 0,
      posterCount: 0,
      postersAtOrAboveThreshold: 0
    })
  })
})

describe('computeMessageLengthStats', () => {
  const context = { startTime: onDemandStart, directNames }

  it('reports the typical and longest message length in words', () => {
    const messages = [
      onDemandMessage('ana', 1, 'one'), // 1 word
      onDemandMessage('bo', 2, 'two words here'), // 3 words
      onDemandMessage('cy', 3, 'a rather longer message than the others') // 7 words
    ]

    expect(computeMessageLengthStats(messages, {}, context)).toEqual({
      messageCount: 3,
      medianWordCount: 3,
      longestWordCount: 7
    })
  })

  it('nulls both statistics when the slice holds no messages', () => {
    expect(computeMessageLengthStats([], {}, context)).toEqual({
      messageCount: 0,
      medianWordCount: null,
      longestWordCount: null
    })
  })

  it('reads the text of a rich message body the same way a plain one is read', () => {
    const messages = [{ owner: 'ana', createdAt: atMinute(1), channels: ['chat'], body: { text: 'two words' } }]

    expect(computeMessageLengthStats(messages, {}, context).longestWordCount).toBe(2)
  })
})

describe('loadMessagesForOnDemandMetrics', () => {
  it('loads the same human messages the metrics count, oldest first, with their direct channels resolved', async () => {
    const conversation = await Conversation.create({
      name: 'On-demand event',
      slug: `ondemand-${new mongoose.Types.ObjectId().toString()}`,
      owner: ownerId,
      topic: new mongoose.Types.ObjectId(),
      transcript: { status: 'stopped' }
    })
    const directChannel = await Channel.create({
      name: `dm-${new mongoose.Types.ObjectId().toString()}`,
      direct: true,
      participants: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()]
    })
    await Message.create([
      {
        body: 'second',
        conversation: conversation._id,
        owner: ownerFor('ana'),
        pseudonymId: ownerId,
        pseudonym: 'ana',
        fromAgent: false,
        channels: ['main'],
        createdAt: new Date('2026-07-01T12:05:00.000Z')
      },
      {
        body: 'first',
        conversation: conversation._id,
        owner: ownerFor('bo'),
        pseudonymId: ownerId,
        pseudonym: 'bo',
        fromAgent: false,
        channels: [directChannel.name],
        createdAt: new Date('2026-07-01T12:01:00.000Z')
      },
      // Excluded the same way every other metric excludes them: the bot's own messages, the
      // spoken transcript, and anything hidden.
      { body: 'bot', conversation: conversation._id, pseudonymId: ownerId, pseudonym: 'bot', fromAgent: true },
      {
        body: 'spoken',
        conversation: conversation._id,
        owner: ownerFor('cy'),
        pseudonymId: ownerId,
        pseudonym: 'cy',
        fromAgent: false,
        channels: ['transcript']
      },
      {
        body: 'hidden',
        conversation: conversation._id,
        owner: ownerFor('cy'),
        pseudonymId: ownerId,
        pseudonym: 'cy',
        fromAgent: false,
        visible: false
      }
    ])

    const { messages, directNames: resolvedDirectNames } = await loadMessagesForOnDemandMetrics(conversation._id)

    expect(messages.map((message) => message.body)).toEqual(['first', 'second'])
    expect(resolvedDirectNames).toEqual(new Set([directChannel.name]))
  })
})
