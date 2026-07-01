/*
 * Seeds a public test event with realistic engagement so the Vibes Analyst's
 * recap card shows real, varied numbers when you stop the event.
 *
 * Background: the Vibes Analyst is a Slack bot that posts an engagement recap to an
 * admin channel as soon as a public event ends. The recap draws on two kinds of
 * data, kept separate on purpose:
 *   - Participation: exact counts from our own database. How many people joined
 *     the event, how many of them actually sent a message, and when those
 *     messages happened. These are precise.
 *   - Tracked sessions: web-analytics estimates of who visited the event, pulled
 *     from a tool like Matomo (visits, time on page, device mix). Tracking
 *     can miss people, so these can undercount and are never treated as exact.
 *
 * To make all of that show up, this script creates:
 *   - Followers on the event: the "joined" count, the denominator of the
 *     participation rate (registered people vs people who actually spoke).
 *   - Messages spread across the event's time window, so the "messages over time"
 *     chart has a real shape
 *   - A mix of private one-to-one-with-the-bot messages and public group-chat
 *     messages
 *   - A few earlier events in the SAME topic, already ended, so the card can compare
 *     this event against the topic's recent average (its baseline).
 *   - Optionally a stored tracked-session snapshot (see TRACKED_STATE below), so the
 *     tracked-session insights and the device chart appear.
 *
 * This writes the event's data straight into the database and skips the normal
 * "start" step (which would attach live chat adapters and a transcript we do not
 * need for testing here). Stopping still works anyway: the stop endpoint does not require an
 * event to have been started, so it just marks this one ended and announces it. The
 * Vibes Analyst is a separate, always-running bot that listens for that "event
 * ended" announcement and posts the recap; it is not attached to this event. The
 * event's start time is written in the past (see DURATION_MINUTES) so the recap
 * still shows a real event length, and because there is no transcript, stopping
 * makes no summary call.
 *
 * Run against the SAME database your dev server uses (NODE_ENV unset/development,
 * so config points at MONGODB_URL, not the -test database):
 *
 *   ADMIN_EMAIL=you@example.com node --loader ts-node/esm tests/manual/seedVibesAnalystTestEvent.ts
 *
 * TRACKED_STATE picks which tracked-session situation to simulate (default
 * 'available'). The card words itself differently for each:
 *   TRACKED_STATE=available    web analytics exist for this event, so the card
 *                              shows tracked-session insights alongside participation.
 *   TRACKED_STATE=notTracked   no analytics were ever set up for this event, so the
 *                              card is messages-only and says tracking was not on.
 *   TRACKED_STATE=unavailable  analytics were set up but no data came back (the fetch
 *                              failed or has not run), so the card is messages-only
 *                              and says the data could not be retrieved.
 *
 * Shape the story with these env vars (all optional, defaults in parens):
 *   REGISTERED        people registered, the participation denominator (53)
 *   DURATION_MINUTES  how long the event ran, sets the activity window (90)
 *   PARTICIPANTS      distinct people who spoke (17)
 *   AVG_MESSAGES      average messages per speaker (2.6)
 *   PUBLIC_SHARE      fraction of messages in public chat vs private-to-bot (0.5)
 *   ACTIVITY_SHAPE    front-load exponent; >1 tapers off toward the end (1.6)
 *   PAST_EVENTS       earlier same-topic events to average into the baseline (4)
 *   PAST_RATE         baseline participation rate of those past events (0.57)
 *   TRACKED_ATTENDEES tracked unique visitors (40)
 *   TRACKED_VISITS    tracked sessions; device split scales with this (100)
 *   TRACKED_ACTIONS   tracked total actions (820)
 *   TRACKED_DWELL     tracked total dwell seconds (114000)
 *   DEVICE_SPLIT      device mix as label:weight pairs, scaled to TRACKED_VISITS
 *                     (desktop:62,mobile:30,tablet:8). Weights need not sum to 100.
 *
 * Example, a small, highly engaged event that beats a weak baseline (22 of 30
 * registered spoke, a 73% rate, against a 40% topic average) on a phone-heavy crowd:
 *   REGISTERED=30 PARTICIPANTS=22 PAST_RATE=0.4 TRACKED_VISITS=60 DEVICE_SPLIT=desktop:20,mobile:70,tablet:10 \
 *     ADMIN_EMAIL=you@example.com node --loader ts-node/esm tests/manual/seedVibesAnalystTestEvent.ts
 *
 * Then, with an admin bearer token:
 *   POST /v1/conversations/<printed id>/stop
 * and watch the recap card land in the Vibes Analyst's admin channel.
 *
 * Matomo credentials are not needed: the snapshot is written here directly. The
 * stop-time Matomo fetch only fires for an event opted into a Matomo source, and
 * only TRACKED_STATE=unavailable does that here. So if your dev env has real
 * MATOMO_* set, leave them unset for the unavailable run, or stopping will query
 * Matomo for that event and may overwrite the missing-data state. The available
 * and notTracked runs opt into no source, so MATOMO_* never affects them.
 */
import mongoose from 'mongoose'
import config from '../../src/config/config.js'
import logger from '../../src/config/logger.js'
import Topic from '../../src/models/topic.model.js'
import Conversation from '../../src/models/conversation.model.js'
import Channel from '../../src/models/channel.model.js'
import Message from '../../src/models/message.model.js'
import Follower from '../../src/models/follower.model.js'
import ConversationAnalytics from '../../src/models/conversationAnalytics.model.js'
import User from '../../src/models/user.model/user.model.js'

// ---- Tunables: shape the story the card tells via env vars (see header) ----

/* Reads a numeric env var, falling back to a default when it is unset or blank.
   Throws on a value that is present but not a number, so a typo fails loudly
   rather than silently seeding nonsense. */
function numEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a number, got "${raw}"`)
  return parsed
}

// How many people "registered" for this event (the participation denominator).
const registeredCount = numEnv('REGISTERED', 53)

// How long the event ran. startTime is set this many minutes in the past so the
// activity chart spans a real window.
const eventDurationMinutes = numEnv('DURATION_MINUTES', 90)

// Front-load exponent for placing messages across the window. >1 means more
// messages land early, so the activity chart tapers off toward the end.
const activityShape = numEnv('ACTIVITY_SHAPE', 1.6)

// Which tracked-session state to seed. See the header comment.
const trackedState = (process.env.TRACKED_STATE || 'available') as 'available' | 'notTracked' | 'unavailable'

const NAME_POOL = [
  'Ada',
  'Blake',
  'Cleo',
  'Dev',
  'Esi',
  'Finn',
  'Gia',
  'Hugo',
  'Ivy',
  'Jonas',
  'Kira',
  'Liam',
  'Mara',
  'Noor',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
  'Uma',
  'Vik',
  'Wren',
  'Xan',
  'Yara',
  'Zane'
]

/* Builds the people who actually spoke. Distributes `count * avgMessages` total
   messages across `count` speakers with a linear decay, so the first names carry
   more of the volume and the top-talker concentration has something to surface.
   Each speaker's share is then split into public chat vs private-to-bot by
   publicShare. */
function buildParticipants(count: number, avgMessages: number, publicShare: number) {
  const names = Array.from({ length: count }, (_, i) =>
    i < NAME_POOL.length ? NAME_POOL[i] : `${NAME_POOL[i % NAME_POOL.length]} ${Math.floor(i / NAME_POOL.length) + 1}`
  )
  const totalMessages = Math.round(count * avgMessages)
  const weights = names.map((_, i) => count - i)
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)

  let assigned = 0
  const perPerson = weights.map((weight) => {
    const share = Math.round((weight / weightSum) * totalMessages)
    assigned += share
    return share
  })
  // Push any rounding drift onto the busiest speaker so the totals stay exact.
  perPerson[0] = Math.max(0, perPerson[0] + (totalMessages - assigned))

  return names.map((name, i) => {
    const total = perPerson[i]
    const publicMessages = Math.round(total * publicShare)
    return { name, privateMessages: total - publicMessages, publicMessages }
  })
}

// People who actually spoke. The distinct count is participantCount, so with the
// defaults (17 speakers, 53 registered) the participation rate lands around 32%.
const participants = buildParticipants(numEnv('PARTICIPANTS', 17), numEnv('AVG_MESSAGES', 2.6), numEnv('PUBLIC_SHARE', 0.5))

/* Builds earlier same-topic events, already ended, that the card averages into the
   recent baseline. They are spaced a week apart (oldest first) and hover around
   baseRate, so with the defaults today's ~32% reads as well below the topic norm. */
function buildPastEvents(count: number, baseRate: number) {
  return Array.from({ length: count }, (_, i) => ({
    // Nudge each event a little around the base so the baseline is not a flat line.
    rate: Math.min(0.95, Math.max(0.05, baseRate + ((i % 3) - 1) * 0.03)),
    registered: 40 + i * 3,
    dwellSeconds: 1500 - i * 40,
    daysAgo: (count - i) * 7
  }))
}

const pastEvents = buildPastEvents(numEnv('PAST_EVENTS', 4), numEnv('PAST_RATE', 0.57))

/* Parses DEVICE_SPLIT (e.g. "desktop:30,mobile:60,tablet:10") into device weights,
   falling back to a desktop-leaning default. The weights need not add up to 100;
   they are normalized when the counts are built. */
function deviceWeights(): Record<string, number> {
  const raw = process.env.DEVICE_SPLIT
  if (!raw) return { desktop: 62, mobile: 30, tablet: 8 }

  const weights: Record<string, number> = {}
  for (const pair of raw.split(',')) {
    const [label, weight] = pair.split(':').map((part) => part.trim())
    const value = Number(weight)
    if (!label || Number.isNaN(value)) throw new Error(`DEVICE_SPLIT must be "label:number" pairs, got "${pair}"`)
    weights[label] = value
  }
  return weights
}

/* Splits `visits` across the device weights, normalizing them and pushing any
   rounding drift onto the heaviest bucket so the counts sum to exactly `visits`. */
function buildDeviceBreakdown(visits: number): Record<string, number> {
  const weights = deviceWeights()
  const labels = Object.keys(weights)
  const weightSum = labels.reduce((sum, label) => sum + weights[label], 0)
  if (weightSum <= 0) throw new Error('DEVICE_SPLIT weights must add up to more than zero')

  let assigned = 0
  const breakdown: Record<string, number> = {}
  for (const label of labels) {
    breakdown[label] = Math.round((weights[label] / weightSum) * visits)
    assigned += breakdown[label]
  }
  const heaviest = labels.reduce((a, b) => (weights[a] >= weights[b] ? a : b))
  breakdown[heaviest] = Math.max(0, breakdown[heaviest] + (visits - assigned))
  return breakdown
}

// The stored tracked-session snapshot for TRACKED_STATE=available. With the
// defaults, totalVisits (100) far exceeds the ~17 people who spoke, the kind of
// "big listening crowd, few talkers" gap the analyst is meant to surface. The
// device split scales with totalVisits and defaults to desktop-leaning; set
// DEVICE_SPLIT to change the mix.
const trackedVisits = numEnv('TRACKED_VISITS', 100)
const trackedSnapshot = {
  attendeeCount: numEnv('TRACKED_ATTENDEES', 40),
  totalVisits: trackedVisits,
  totalActions: numEnv('TRACKED_ACTIONS', 820),
  totalDwellSeconds: numEnv('TRACKED_DWELL', 114000),
  deviceBreakdown: buildDeviceBreakdown(trackedVisits)
}

function newId() {
  return new mongoose.Types.ObjectId()
}

/* Registers `count` people on an event by creating Follower documents. The card
   only counts these documents for the denominator, so we use throwaway user ids
   rather than creating real user accounts. */
async function addFollowers(conversationId: mongoose.Types.ObjectId, topicId: mongoose.Types.ObjectId, count: number) {
  const followers = Array.from({ length: count }, () => ({ user: newId(), conversation: conversationId, topic: topicId }))
  await Follower.insertMany(followers)
}

/* Creates one human message and forces its createdAt to `when`. createdAt is
   immutable once set, so we write it through the native driver, which is how the
   activity chart ends up with messages spread across the event window. */
async function addHumanMessageAt(
  conversationId: mongoose.Types.ObjectId,
  channelName: string,
  pseudonym: string,
  body: string,
  when: Date
) {
  const message = await Message.create({
    body,
    bodyType: 'text',
    conversation: conversationId,
    channels: [channelName],
    pseudonym,
    pseudonymId: newId(),
    owner: newId(),
    fromAgent: false,
    visible: true,
    pause: 0,
    upVotes: [],
    downVotes: []
  })
  await Message.collection.updateOne({ _id: message._id }, { $set: { createdAt: when, updatedAt: when } })
}

/* Builds one already-ended past event in the topic so the baseline has history to
   average. Registers `registered` people, has round(rate * registered) of them
   each send one message, and stores a tracked-session snapshot so the dwell-time
   baseline has something to average too. */
async function seedPastEvent(
  topicId: mongoose.Types.ObjectId,
  ownerId: mongoose.Types.ObjectId,
  index: number,
  spec: (typeof pastEvents)[number]
) {
  const endTime = new Date(Date.now() - spec.daysAgo * 24 * 60 * 60 * 1000)
  const startTime = new Date(endTime.getTime() - eventDurationMinutes * 60 * 1000)
  const conversation = await Conversation.create({
    name: `VA Past Event ${index + 1}`,
    owner: ownerId,
    topic: topicId,
    startTime,
    endTime
  })

  await addFollowers(conversation._id, topicId, spec.registered)

  const speakers = Math.round(spec.rate * spec.registered)
  for (let i = 0; i < speakers; i += 1) {
    await addHumanMessageAt(conversation._id, 'chat', `past-${index + 1}-speaker-${i}`, 'past message', startTime)
  }

  await ConversationAnalytics.create({
    conversationId: conversation._id,
    source: 'matomo',
    attendeeCount: spec.registered,
    totalVisits: spec.registered + 20,
    totalActions: 600,
    totalDwellSeconds: spec.dwellSeconds * (spec.registered + 20),
    deviceBreakdown: { desktop: 50, mobile: 30 },
    capturedAt: endTime
  })

  return conversation
}

async function seed() {
  const adminEmail = process.env.ADMIN_EMAIL
  if (!adminEmail) throw new Error('Set ADMIN_EMAIL to the email you log into the API with (the event owner).')

  const admin = await User.findOne({ email: adminEmail.toLowerCase() })
  if (!admin) throw new Error(`No user found with email ${adminEmail}. Use the email you log into the API with.`)

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const name = `VA Test Event ${stamp}`

  // Public topic (private:false) so the Vibes Analyst's allPublicTopics grant matches.
  const topic = await Topic.create({
    name,
    slug: `va-test-${newId().toString().slice(-6)}`,
    private: false,
    votingAllowed: true,
    conversationCreationAllowed: true,
    archivable: true,
    owner: admin._id
  })

  for (const [index, spec] of pastEvents.entries()) {
    await seedPastEvent(topic._id, admin._id, index, spec)
  }

  const now = Date.now()
  const startMs = now - eventDurationMinutes * 60 * 1000
  const conversation = await Conversation.create({
    name,
    owner: admin._id,
    topic: topic._id,
    enableAgents: false,
    startTime: new Date(startMs)
  })

  await addFollowers(conversation._id, topic._id, registeredCount)

  // Order every human message, then place each one across the window with an
  // earlier bias (frac ** 1.6), so the activity chart tapers off toward the end.
  const queued: Array<{ channel: string; pseudonym: string; body: string }> = []
  for (const participant of participants) {
    const directChannelName = `direct-agents-${newId()}`
    // Direct channels require exactly 2 participants (the person and the bot).
    const directChannel = await Channel.create({ name: directChannelName, direct: true, participants: [newId(), newId()] })
    conversation.channels.push(directChannel)

    for (let i = 0; i < participant.privateMessages; i += 1) {
      queued.push({ channel: directChannelName, pseudonym: participant.name, body: `private note ${i + 1}` })
    }
    for (let i = 0; i < participant.publicMessages; i += 1) {
      queued.push({ channel: 'chat', pseudonym: participant.name, body: `public message ${i + 1}` })
    }
  }

  for (const [index, item] of queued.entries()) {
    const frac = queued.length > 1 ? (index / (queued.length - 1)) ** activityShape : 0
    const when = new Date(startMs + frac * (now - startMs))
    await addHumanMessageAt(conversation._id, item.channel, item.pseudonym, item.body, when)
  }

  if (trackedState === 'available') {
    await ConversationAnalytics.create({
      conversationId: conversation._id,
      source: 'matomo',
      ...trackedSnapshot,
      capturedAt: new Date()
    })
  } else if (trackedState === 'unavailable') {
    // A source is opted in but no snapshot exists, so the card reports tracked data
    // as unavailable rather than "not tracked". The ref names the Matomo dimension
    // that carries the conversation id (the adapter pairs it with the id at fetch).
    conversation.analyticsRefs = new Map([['matomo', 'dimension7']])
  }

  await conversation.save()

  const participantCount = participants.length
  const messageCount = queued.length
  const rate = Math.round((participantCount / registeredCount) * 100)
  logger.info(`Seeded event "${name}"`)
  logger.info(`  conversationId: ${conversation._id}`)
  logger.info(`  registered: ${registeredCount}, spoke: ${participantCount} (~${rate}%), messages: ${messageCount}`)
  logger.info(`  past events in topic: ${pastEvents.length}, tracked-session state: ${trackedState}`)
  logger.info(`Stop it to trigger the card:`)
  logger.info(`  POST /v1/conversations/${conversation._id}/stop   (as ${adminEmail})`)
}

try {
  await mongoose.connect(config.mongoose.url)
  await seed()
} catch (err) {
  logger.error(`Seed failed: ${(err as Error).message}`)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}
