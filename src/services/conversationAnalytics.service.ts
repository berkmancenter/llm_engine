import Message from '../models/message.model.js'
import Channel from '../models/channel.model.js'
import Conversation from '../models/conversation.model.js'
import ConversationAnalytics from '../models/conversationAnalytics.model.js'
import ConversationMetricsSnapshot from '../models/conversationMetricsSnapshot.model.js'
import { matchBotMention } from '../agents/helpers/intentChecks.js'
import eventDateLabel from '../utils/eventDateLabel.js'
import config from '../config/config.js'
import {
  ActivityBucket,
  AttendanceBand,
  AudienceEngagement,
  BotInvocations,
  ChatSpike,
  ConversationMetrics,
  EventPlatform,
  InteractionStructure,
  ParticipationConcentration,
  ParticipationHistoryPoint,
  ParticipationMetrics,
  PeerBaseline,
  PrivateMessaging,
  ReplyLatency,
  ResourceSummary,
  SameTopicBaseline,
  SpikeSource,
  TimeToFirstMessage,
  TrackedSessionMetrics,
  TrackedSessionStatus
} from '../types/index.types.js'

/* The version of the metric definitions this service computes. Every persisted
   ConversationMetricsSnapshot is stamped with it, and the baseline only averages snapshots that
   share the current version, so a trend that crosses a definition change is never read as a
   continuous line. Bump it by one whenever a metric's meaning or calculation changes (the
   same change that METRICS.md asks you to document), so old values keep the meaning they had
   when they were captured. Adding a brand-new metric does not require a bump, since it cannot
   make an existing value misleading. */
export const METRICS_VERSION = 1

/* Six windows keeps the activity chart readable and under Slack's 20-point limit. */
const ACTIVITY_BUCKET_COUNT = 6

/* The one predicate that defines "a human message for this event". Every human-message
   query below spreads this in alongside the conversation id, so all three metrics
   (participation, channel split, activity series) count the exact same set of messages
   and stay mutually consistent.

   fromAgent:false drops the bot's own messages.

   channels:$ne 'transcript' drops the talk transcript, which is saved as non-agent
   messages on the 'transcript' channel. Those are the speaker's spoken words, not live
   chat, so fromAgent:false alone would still count them as live participant chat and
   inflate the poster and message counts. report.service excludes it the same way.

   visible:true drops backchannel and hidden messages, so only messages a person actually
   sent in the open are counted. visible is required and defaults to true, so a real chat
   message always carries it. This intentionally counts replies (parentMessage set) too,
   unlike Conversation.messageCount, which counts only top-level posts: a threaded reply is
   still a message a participant sent, and an engagement recap should reflect every one. */
const visibleHumanFilter = { fromAgent: false, visible: true, channels: { $ne: 'transcript' } }

/* A chat spike is a window holding at least this many times the messages of the
   average other window. The other-windows average is the baseline, so a single
   busy window never inflates the bar it is judged against. */
const SPIKE_MULTIPLE = 2

/* The spike floor scales with how many people posted: a window must hold at least
   this share of the poster count to count, so a busy minute in a small room still
   registers while idle chatter in a large one does not. */
const SPIKE_FLOOR_FRACTION = 0.1

/* The floor never drops below this, so a two-message blip is never a spike even in
   a tiny event. */
const SPIKE_ABSOLUTE_FLOOR = 3

/* Below three windows there is no meaningful baseline to stand out from, so a very
   short event reports no spikes rather than a shaky one. */
const MIN_BUCKETS_FOR_SPIKE = 3

/* A time window with its message count, carrying the minute offsets from the event
   start so a later step can pull the messages sent during it. */
export interface TimedActivityBucket {
  startMinute: number
  endMinute: number
  messageCount: number
}

/* The baseline averages at most this many recent past events in the same topic, so
   a long-running series is compared to its recent average rather than all of it. */
const BASELINE_EVENT_LIMIT = 10

/* A handful of posters. Below this, naming a "few voices dominated" share is
   meaningless, so the frequent-poster share is reported as null instead. Shared with
   the participation-concentration share, which becomes trivial in the same small room. */
const FREQUENT_POSTER_MIN_POSTERS = 5

/* How many top posters the concentration share covers. A fixed few, so it measures a tight
   core regardless of room size, unlike the frequent-poster share, which is the top 10% and so
   widens with the crowd. */
const CONCENTRATION_TOP_POSTERS = 3

/* Fixed posterCount tiers a peer cohort is bucketed by (see PeerBaseline). Deliberately small:
   this platform's largest events run at most 75-100 attendees, so a "large" event here is
   nowhere near a large public conference. */
const ATTENDANCE_BAND_MAX: { name: AttendanceBand; max: number | null }[] = [
  { name: 'tiny', max: 9 },
  { name: 'small', max: 24 },
  { name: 'medium', max: 49 },
  { name: 'large', max: null }
]

/* Buckets a posterCount into its attendance band. Exported so the same bucketing that builds a
   peer cohort can also be asserted on directly, without needing a live query. */
export function attendanceBandFor(posterCount: number): AttendanceBand {
  const band = ATTENDANCE_BAND_MAX.find((candidate) => candidate.max === null || posterCount <= candidate.max)
  return band!.name
}

/* The posterCount range (inclusive) for a given band, used to build the peer cohort query. */
function attendanceBandRange(band: AttendanceBand): { min: number; max: number | null } {
  const index = ATTENDANCE_BAND_MAX.findIndex((candidate) => candidate.name === band)
  const min = index === 0 ? 0 : ATTENDANCE_BAND_MAX[index - 1].max! + 1
  return { min, max: ATTENDANCE_BAND_MAX[index].max }
}

/* At most this many recent peers make up a cohort average, the same span as the same-topic
   baseline (BASELINE_EVENT_LIMIT), so neither reads as more current than the other. */
const PEER_COHORT_EVENT_LIMIT = 10

/* Below this many qualifying public peers, a cohort average would read as more authoritative
   than a 1- or 2-event sample actually is, so the baseline is reported as null instead (the
   same "thin data reports null" precedent as the same-topic baseline and the frequent-poster
   share). */
const PEER_COHORT_MIN_EVENTS = 3

/* How many raw candidates to pull before the privacy filter runs. Generous relative to
   PEER_COHORT_EVENT_LIMIT because some candidates will belong to a private topic and get
   dropped, and the candidates are already sorted newest-first so the final slice after
   filtering is still the most recent qualifying peers. */
const PEER_COHORT_CANDIDATE_LIMIT = 50

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/* Counts participation from our own database, so these numbers are exact. A poster is
   anyone who sent at least one non-bot message; fromAgent:false drops the bot's own
   messages. Frequent posters are the top 10% of posters by message volume (always at
   least one once anyone has posted), and we also return their share of all messages so
   the card can flag when a few voices dominated.

   We group by owner (the BaseUser ref, the actual person) rather than pseudonym. A
   person's pseudonym can rotate during an event: addPseudonym flips the old one
   inactive and assigns a new active one, and each message stores whatever pseudonym was
   active when it was sent. Grouping by the pseudonym string would therefore count one
   person who rotated mid-event as several posters. owner is required:false on the schema,
   so for the rare owner-less message we fall back to pseudonymId, the id of the pseudonym
   that sent it. That id is steadier than the display string (which can differ for the
   same pseudonym), though only owner ties a guest together across a rename. */
async function computeParticipation(conversationId): Promise<ParticipationMetrics> {
  const byPoster: { _id: string; count: number }[] = await Message.aggregate([
    { $match: { conversation: conversationId, ...visibleHumanFilter } },
    { $group: { _id: { $ifNull: ['$owner', '$pseudonymId'] }, count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ])

  const posterCount = byPoster.length
  const messageCount = byPoster.reduce((sum, poster) => sum + poster.count, 0)

  /* Below a handful of posters a "few voices dominated" share is meaningless, so report
     no frequent posters and a null share rather than a misleading one. */
  if (posterCount < FREQUENT_POSTER_MIN_POSTERS) {
    return { posterCount, frequentPosterCount: 0, frequentPosterMessageShare: null, messageCount }
  }

  /* Top 10% of posters by message volume, rounded up. byPoster is sorted by count
     descending, so the cutoff is the count of the last poster in that top slice. */
  const topSlice = Math.max(1, Math.ceil(posterCount * 0.1))
  const cutoffCount = byPoster[topSlice - 1].count

  /* Include every poster tied at the cutoff count, not just the first topSlice of them,
     so a boundary tie is resolved by message volume rather than arbitrary sort order. */
  const frequentPosters = byPoster.filter((poster) => poster.count >= cutoffCount)
  const frequentPosterCount = frequentPosters.length
  const frequentPosterMessages = frequentPosters.reduce((sum, poster) => sum + poster.count, 0)
  const frequentPosterMessageShare = messageCount > 0 ? frequentPosterMessages / messageCount : 0

  return { posterCount, frequentPosterCount, frequentPosterMessageShare, messageCount }
}

/* Averages an action breakdown over the active-visitor count, the Bucket-1 denominator.
   Returns an empty map when no one was active, so a zero denominator never produces NaN.
   Mirrors how avgDwellSeconds is derived at read time rather than stored. */
function perActiveVisitor(breakdown: Record<string, number>, activeVisitorCount: number): Record<string, number> {
  if (activeVisitorCount <= 0) return {}
  const averages: Record<string, number> = {}
  for (const [key, count] of Object.entries(breakdown)) {
    averages[key] = count / activeVisitorCount
  }
  return averages
}

/* Converts one stored analytics summary (a ConversationAnalytics document: raw
   visit/dwell counts from a provider like Matomo) into the numbers the card shows.
   Averages and rates are computed here and never saved. A summary with zero visits
   yields 0 instead of NaN. */
function deriveTrackedSessions(snapshot): TrackedSessionMetrics {
  const totalVisits = snapshot.totalVisits ?? 0
  const actionBreakdown = (snapshot.actionBreakdown as Record<string, number>) ?? {}
  const activeVisitorCount = snapshot.activeVisitorCount ?? 0
  return {
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    trackedSessions: totalVisits,
    attendeeCount: snapshot.attendeeCount ?? 0,
    avgDwellSeconds: totalVisits > 0 ? (snapshot.totalDwellSeconds ?? 0) / totalVisits : 0,
    totalActions: snapshot.totalActions ?? 0,
    deviceBreakdown: (snapshot.deviceBreakdown as Record<string, number>) ?? {},
    actionBreakdown,
    actionUserBreakdown: (snapshot.actionUserBreakdown as Record<string, number>) ?? {},
    activeVisitorCount,
    actionBreakdownPerActiveVisitor: perActiveVisitor(actionBreakdown, activeVisitorCount)
  }
}

/* Splits the event into equal time windows and counts the people's messages in
   each, so the recap can show when the room was busy. The windows span the event's
   start and end times; if those are missing it falls back to the first and last
   message times.

   Messages sent before the window starts or after it ends are excluded entirely,
   not folded into the first or last bucket. A pre-event "is this thing on?" or a
   post-event goodbye would otherwise clamp onto an edge bucket and overstate how
   busy the room was at the very start or end of the talk. When start and end fall
   back to the first and last message times, every message is in window by
   definition, so nothing is dropped. Each window keeps its minute offsets so a later
   step can pull the messages sent during it. Returns [] when no messages land in the
   window. */
function bucketMessagesOverTime(messages: { createdAt?: Date }[], startTime?: Date, endTime?: Date): TimedActivityBucket[] {
  const dated = messages.filter((message): message is { createdAt: Date } => message.createdAt instanceof Date)
  if (dated.length === 0) return []

  const startMs = (startTime ?? dated[0].createdAt).getTime()
  const endMs = (endTime ?? dated[dated.length - 1].createdAt).getTime()

  const inWindow = dated.filter((message) => {
    const messageMs = message.createdAt.getTime()
    return messageMs >= startMs && messageMs <= endMs
  })
  if (inWindow.length === 0) return []

  const totalMinutes = Math.max(0, Math.round((endMs - startMs) / 60000))

  // A zero-length window (all messages in one minute) collapses to a single bucket.
  if (totalMinutes === 0) {
    return [{ startMinute: 0, endMinute: 0, messageCount: inWindow.length }]
  }

  const bucketSizeMinutes = Math.ceil(totalMinutes / ACTIVITY_BUCKET_COUNT)
  const buckets: TimedActivityBucket[] = []
  for (let index = 0; index < ACTIVITY_BUCKET_COUNT; index += 1) {
    const startMinute = index * bucketSizeMinutes
    if (startMinute >= totalMinutes) break
    const endMinute = Math.min(startMinute + bucketSizeMinutes, totalMinutes)
    buckets.push({ startMinute, endMinute, messageCount: 0 })
  }

  for (const message of inWindow) {
    const minutesFromStart = (message.createdAt.getTime() - startMs) / 60000
    const index = Math.min(Math.max(Math.floor(minutesFromStart / bucketSizeMinutes), 0), buckets.length - 1)
    buckets[index].messageCount += 1
  }

  return buckets
}

/* Builds the chart label for one window. A window runs from startMinute up to but not
   including endMinute, so its last whole minute is endMinute - 1. Labeling by that
   inclusive range ('0-9', '10-19') keeps adjacent windows from sharing a boundary
   number the way '0-10' and '10-20' both claimed minute 10, so a reader can tell which
   window owns any given minute. A one-minute window and a zero-length window (start and
   end equal, all messages in one minute) collapse to a single number. */
function bucketLabel(startMinute: number, endMinute: number): string {
  const lastMinute = Math.max(startMinute, endMinute - 1)
  return lastMinute === startMinute ? `${startMinute}` : `${startMinute}-${lastMinute}`
}

/* Maps the timed buckets to the chart-ready series the card renders: a minute-range
   label and a count per window. */
function toActivitySeries(buckets: TimedActivityBucket[]): ActivityBucket[] {
  return buckets.map((bucket) => ({
    label: bucketLabel(bucket.startMinute, bucket.endMinute),
    messageCount: bucket.messageCount
  }))
}

/**
 * Flags the windows where chat volume stood out from the rest of the event. A
 * window is a spike when it clears two bars at once: it holds at least SPIKE_MULTIPLE
 * times the average of the other windows, and it clears a floor that scales with the
 * poster count. The relative test catches a genuine burst; the floor stops a tiny
 * absolute jump from reading as one in a quiet room. Spikes come back in chronological
 * order, each carrying its window and how far above baseline it ran, so the recap can
 * name when the room lit up and a later step can read what was said then.
 */
export function computeSpikes(buckets: TimedActivityBucket[], posterCount: number): ChatSpike[] {
  if (buckets.length < MIN_BUCKETS_FOR_SPIKE) return []

  const floor = Math.max(SPIKE_ABSOLUTE_FLOOR, Math.ceil(posterCount * SPIKE_FLOOR_FRACTION))
  const totalMessages = buckets.reduce((sum, bucket) => sum + bucket.messageCount, 0)

  const toSpike = (bucket: TimedActivityBucket, baselineAverage: number): ChatSpike => ({
    label: bucketLabel(bucket.startMinute, bucket.endMinute),
    startMinute: bucket.startMinute,
    endMinute: bucket.endMinute,
    messageCount: bucket.messageCount,
    baselineAverage,
    ratio: baselineAverage > 0 ? bucket.messageCount / baselineAverage : null,
    // Detection works on counts alone and cannot see channels; attributeSpikeSources
    // overwrites this from the window's messages once the spikes are known.
    source: 'chat'
  })

  /* When every window but the busiest is empty, the busiest window's baseline (the
     average of the others) is zero, and the multiple test count >= SPIKE_MULTIPLE * 0
     passes any non-empty window on the floor alone. The multiple is meaningless against
     a zero baseline, so fall back to raw counts: pick only the single window with the
     most messages, and only if it clears the floor. */
  const busiest = buckets.reduce((top, bucket) => (bucket.messageCount > top.messageCount ? bucket : top), buckets[0])
  const busiestBaseline = (totalMessages - busiest.messageCount) / (buckets.length - 1)
  if (busiestBaseline === 0) {
    return busiest.messageCount >= floor ? [toSpike(busiest, 0)] : []
  }

  const spikes: ChatSpike[] = []
  for (const bucket of buckets) {
    const baselineAverage = (totalMessages - bucket.messageCount) / (buckets.length - 1)
    const clearsRelative = bucket.messageCount >= SPIKE_MULTIPLE * baselineAverage
    const clearsFloor = bucket.messageCount >= floor
    if (!clearsRelative || !clearsFloor) continue

    spikes.push(toSpike(bucket, baselineAverage))
  }

  return spikes
}

/* Resolves which of the given channel names are private 1:1 channels with the agent. The
   database marks those with direct:true; every other channel (public chat, the moderator
   backchannel, the no-channel main feed) is treated as public. Shared by the channel split
   and the spike attribution so both read "private" the same way from one lookup. */
async function resolveDirectNames(channelNames: string[]): Promise<Set<string>> {
  const directChannels = await Channel.find({ name: { $in: channelNames }, direct: true }).select('name')
  return new Set(directChannels.map((channel) => channel.name))
}

/* Counts people's messages as either public chat or private (one-to-one with the bot). A
   message is private when it was sent in a direct channel. Pure over the already-fetched
   messages and the resolved direct-channel names. */
function computeChannelSplit(
  messages: { channels?: string[] }[],
  directNames: Set<string>
): { public: number; private: number } {
  let publicCount = 0
  let privateCount = 0
  for (const message of messages) {
    if ((message.channels ?? []).some((name) => directNames.has(name))) privateCount += 1
    else publicCount += 1
  }
  return { public: publicCount, private: privateCount }
}

/* The person a message is attributed to, the same identity participation groups on: the
   owner (the real account) when present, else the pseudonymId. Stringified so it can key a
   Set. Returns null for a message with neither, which is dropped from the distinct-sender
   counts rather than collapsed into one phantom sender. */
function senderKey(message: { owner?: unknown; pseudonymId?: unknown }): string | null {
  const id = message.owner ?? message.pseudonymId
  return id ? String(id) : null
}

/* Counts private (one-to-one with the bot) messaging from the already-fetched messages. It
   reuses channelSplit's private count and groups senders the same way participation does, so
   the distinct-sender counts reconcile with posterCount. avgPrivateMessagesPerPoster divides
   the private count by the total distinct posters and is 0 when no one posted, mirroring how
   the other read-time averages avoid a zero denominator. Pure over the fetched messages, the
   resolved direct-channel names, and the poster count. */
function computePrivateMessaging(
  messages: { channels?: string[]; owner?: unknown; pseudonymId?: unknown }[],
  directNames: Set<string>,
  posterCount: number
): PrivateMessaging {
  let privateMessageCount = 0
  const privateSenders = new Set<string>()
  const publicSenders = new Set<string>()

  for (const message of messages) {
    const isPrivate = (message.channels ?? []).some((name) => directNames.has(name))
    const sender = senderKey(message)
    if (isPrivate) {
      privateMessageCount += 1
      if (sender) privateSenders.add(sender)
    } else if (sender) {
      publicSenders.add(sender)
    }
  }

  return {
    privateMessageCount,
    distinctPrivateSenders: privateSenders.size,
    distinctPublicSenders: publicSenders.size,
    avgPrivateMessagesPerPoster: posterCount > 0 ? privateMessageCount / posterCount : 0
  }
}

/* Sorts one message into the channel category a spike is attributed by: a private 1:1 with
   the bot, the moderator backchannel, or the public chat (the default for any other
   channel, including the no-channel main feed). */
export function spikeSourceForChannels(channels: string[] | undefined, directNames: Set<string>): SpikeSource {
  const names = channels ?? []
  if (names.some((name) => directNames.has(name))) return 'private'
  if (names.includes('moderator')) return 'moderator'
  return 'chat'
}

/* Stamps each spike with the channel that drove it, read from the messages in its window.
   A spike is 'private' only when its window holds no readable (chat or moderator) messages
   at all, meaning the burst was entirely one-to-one with the bot; that spike is surfaced
   by count alone, since the analyst never reads those messages. Otherwise it is attributed
   to the dominant readable channel, so a later quote always comes from content the analyst
   may read, and a chat-vs-moderator tie favors the public chat. The window runs from
   startMinute (inclusive) to endMinute (exclusive) past the event start, the same bounds
   the activity buckets use. */
export function attributeSpikeSources(
  spikes: ChatSpike[],
  messages: { createdAt?: Date; channels?: string[] }[],
  startTime: Date | undefined,
  directNames: Set<string>
): ChatSpike[] {
  if (spikes.length === 0) return spikes
  const dated = messages.filter(
    (message): message is { createdAt: Date; channels?: string[] } => message.createdAt instanceof Date
  )
  const startMs = (startTime ?? dated[0]?.createdAt)?.getTime()
  if (startMs === undefined) return spikes

  return spikes.map((spike) => {
    const windowStart = startMs + spike.startMinute * 60 * 1000
    const windowEnd = startMs + spike.endMinute * 60 * 1000
    let chat = 0
    let moderator = 0
    for (const message of dated) {
      const sentAt = message.createdAt.getTime()
      if (sentAt < windowStart || sentAt >= windowEnd) continue
      const source = spikeSourceForChannels(message.channels, directNames)
      if (source === 'chat') chat += 1
      else if (source === 'moderator') moderator += 1
    }
    if (chat === 0 && moderator === 0) return { ...spike, source: 'private' }
    return { ...spike, source: chat >= moderator ? 'chat' : 'moderator' }
  })
}

/* Seconds from the event start to the first human message on each surface: the public group
   chat and the private one-to-one with the bot. A message is private when one of its channels
   is a direct channel, the same split computeChannelSplit uses. Pure over the already-fetched
   human messages (fromAgent:false, so the bot's intro never counts), the resolved direct-channel
   names, and the event start. A surface with no timestamped message is null; both are null when
   the start is unknown; a message sent before the start clamps to 0 rather than reporting
   negative time. */
export function computeTimeToFirstMessage(
  messages: { createdAt?: Date; channels?: string[] }[],
  directNames: Set<string>,
  startTime: Date | undefined
): TimeToFirstMessage {
  if (startTime === undefined) return { publicSeconds: null, privateSeconds: null }
  const startMs = startTime.getTime()

  let firstPublicMs: number | null = null
  let firstPrivateMs: number | null = null
  for (const message of messages) {
    if (!(message.createdAt instanceof Date)) continue
    const sentMs = message.createdAt.getTime()
    const isPrivate = (message.channels ?? []).some((name) => directNames.has(name))
    if (isPrivate) {
      if (firstPrivateMs === null || sentMs < firstPrivateMs) firstPrivateMs = sentMs
    } else if (firstPublicMs === null || sentMs < firstPublicMs) {
      firstPublicMs = sentMs
    }
  }

  const toSeconds = (firstMs: number | null): number | null =>
    firstMs === null ? null : Math.max(0, Math.round((firstMs - startMs) / 1000))

  return { publicSeconds: toSeconds(firstPublicMs), privateSeconds: toSeconds(firstPrivateMs) }
}

/* The median of a list of numbers, or null when the list is empty. Averages the two middle
   values for an even count and takes the middle one for an odd count. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/* Reply speed, measured over threaded human replies (parentMessage) so a burst of unrelated
   messages is never read as a fast conversation. For each human message that drew at least one
   reply from another human, it takes the gap to that message's first reply, then reports the
   median of those gaps and how many messages were replied to. A reply whose parent is not in the
   human set (e.g. a reply to the bot) is skipped, since the gap would not be one person answering
   another. Null median with a zero count when nothing was a reply. Pure over the already-fetched
   human messages. */
export function computeReplyLatency(messages: { _id?: unknown; createdAt?: Date; parentMessage?: unknown }[]): ReplyLatency {
  const idOf = (ref: unknown): string => String((ref as { _id?: unknown })?._id ?? ref)

  const createdAtById = new Map<string, number>()
  for (const message of messages) {
    if (message._id != null && message.createdAt instanceof Date) {
      createdAtById.set(idOf(message._id), message.createdAt.getTime())
    }
  }

  const firstReplyByParent = new Map<string, number>()
  for (const message of messages) {
    if (!(message.createdAt instanceof Date) || message.parentMessage == null) continue
    const parentId = idOf(message.parentMessage)
    if (!createdAtById.has(parentId)) continue
    const replyMs = message.createdAt.getTime()
    const existing = firstReplyByParent.get(parentId)
    if (existing === undefined || replyMs < existing) firstReplyByParent.set(parentId, replyMs)
  }

  const gaps: number[] = []
  for (const [parentId, replyMs] of firstReplyByParent) {
    gaps.push(Math.max(0, Math.round((replyMs - (createdAtById.get(parentId) as number)) / 1000)))
  }

  return { medianSecondsToFirstReply: median(gaps), repliedMessageCount: gaps.length }
}

/* Participation concentration over the already-fetched human messages: how much of the chat
   came from the busiest few posters, and how many people posted only once. Groups messages by
   person the same way participation does (owner, else pseudonymId; a message with neither is
   dropped, as in computePrivateMessaging), so its poster count reconciles with participation.
   topPosterCount is how many posters the share spans (CONCENTRATION_TOP_POSTERS, or the poster
   count when smaller). topPosterMessageShare is those posters' share of all messages, null below
   FREQUENT_POSTER_MIN_POSTERS posters, where a top-few share covers nearly the whole room and
   says nothing. oneTimePosterCount and repeatPosterCount split posters by whether they sent
   exactly one message or more, and always sum to the poster count. Pure over the fetched
   messages. */
export function computeParticipationConcentration(
  messages: { owner?: unknown; pseudonymId?: unknown }[]
): ParticipationConcentration {
  const countBySender = new Map<string, number>()
  for (const message of messages) {
    const sender = senderKey(message)
    if (sender === null) continue
    countBySender.set(sender, (countBySender.get(sender) ?? 0) + 1)
  }

  const counts = [...countBySender.values()].sort((a, b) => b - a)
  const posterCount = counts.length
  const messageCount = counts.reduce((sum, count) => sum + count, 0)

  const oneTimePosterCount = counts.filter((count) => count === 1).length
  const repeatPosterCount = posterCount - oneTimePosterCount

  const topPosterCount = Math.min(CONCENTRATION_TOP_POSTERS, posterCount)
  const topMessages = counts.slice(0, topPosterCount).reduce((sum, count) => sum + count, 0)
  const topPosterMessageShare =
    posterCount >= FREQUENT_POSTER_MIN_POSTERS && messageCount > 0 ? topMessages / messageCount : null

  return { topPosterCount, topPosterMessageShare, oneTimePosterCount, repeatPosterCount }
}

/* The shape of threaded conversation over the already-fetched human messages, read from their
   parentMessage links. Builds a forest: each message links to its parent when that parent is in
   the human set, and any other message (no parent, or a reply to something outside the set like
   the bot) is a thread root. Walks each root's subtree for its size (root plus every descendant)
   and its depth (edges from the root, so a direct reply is depth 1). A root counts as a thread
   only once it has at least one reply, so a lone unanswered post is not a thread. Reports the
   thread count, the largest and median thread sizes, and the deepest reply chain, with zeros and
   a null median when nothing was threaded. Pure over the fetched messages. */
export function computeInteractionStructure(messages: { _id?: unknown; parentMessage?: unknown }[]): InteractionStructure {
  const idOf = (ref: unknown): string => String((ref as { _id?: unknown })?._id ?? ref)

  const inSet = new Set<string>()
  for (const message of messages) {
    if (message._id != null) inSet.add(idOf(message._id))
  }

  const childrenByParent = new Map<string, string[]>()
  const roots: string[] = []
  for (const message of messages) {
    if (message._id == null) continue
    const id = idOf(message._id)
    const parentId = message.parentMessage != null ? idOf(message.parentMessage) : null
    if (parentId !== null && inSet.has(parentId)) {
      const siblings = childrenByParent.get(parentId) ?? []
      siblings.push(id)
      childrenByParent.set(parentId, siblings)
    } else {
      roots.push(id)
    }
  }

  const threadSizes: number[] = []
  let maxReplyDepth = 0
  for (const root of roots) {
    let size = 0
    let depth = 0
    /* Depth-first walk from the root. The visited guard only matters if the data ever formed a
       cycle (a reply is always created after its parent, so real threads are acyclic); it keeps a
       malformed link from looping forever. */
    const visited = new Set<string>()
    const stack: { id: string; level: number }[] = [{ id: root, level: 0 }]
    while (stack.length > 0) {
      const { id, level } = stack.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      size += 1
      if (level > depth) depth = level
      for (const child of childrenByParent.get(id) ?? []) {
        stack.push({ id: child, level: level + 1 })
      }
    }

    if (size >= 2) {
      threadSizes.push(size)
      if (depth > maxReplyDepth) maxReplyDepth = depth
    }
  }

  return {
    threadCount: threadSizes.length,
    maxThreadSize: threadSizes.length > 0 ? Math.max(...threadSizes) : 0,
    medianThreadSize: median(threadSizes),
    maxReplyDepth
  }
}

/* Counts how many times participants called on the event's configured assistant by
   name. It reads people's chat messages, the channel where the assistant is summoned,
   and matches each against the bot name the same fuzzy way the assistant itself does,
   so a misspelled or @-prefixed name still counts. The name comes from the event's
   configuration and falls back to the platform default, so a renamed assistant is
   still counted correctly. */
/* Pulls the human-readable text out of a message body. A plain chat message stores a
   string body; a rich or multimodal one stores an object whose typed text lives under
   `text`, the same shape report.service reads. Returns '' for anything without text
   (an image-only body, say), so a mention check never runs over a non-text payload. */
function messageText(body: unknown): string {
  if (typeof body === 'string') return body
  if (body && typeof body === 'object') {
    const { text } = body as Record<string, unknown>
    if (typeof text === 'string') return text
  }
  return ''
}

async function computeBotInvocations(conversation): Promise<BotInvocations> {
  const botName = conversation.properties?.botName || config.conversationBotName
  /* visible:true matches every other human count (see visibleHumanFilter): a hidden or
     backchannel message is not a summon a participant made in the open. */
  const messages = await Message.find({
    conversation: conversation._id,
    fromAgent: false,
    visible: true,
    channels: 'chat'
  }).select('body')

  let count = 0
  for (const message of messages) {
    const text = messageText(message.body)
    if (text.length === 0) continue
    if (matchBotMention(text.trim().split(/\s+/), botName)) count += 1
  }

  return { botName, count }
}

/* The id of an agent reference, whether it arrived as a populated Agent document or a raw
   ObjectId, the same populated-or-not idiom used elsewhere for a conversation's topic ref. */
function agentIdOf(agent): string {
  return (agent?._id ?? agent).toString()
}

/* Counts the distinct people who have joined this conversation, from its direct (1:1 bot-DM)
   channels. joinConversation (see conversation.service) and the Zoom/Slack participant-join
   webhooks both provision one of these automatically the moment someone connects, independent of
   any web-analytics tracking, so this is first-party and exact rather than an estimate that can
   miss someone who blocks tracking.

   A conversation gives each attendee one direct channel per agent on it, so a two-agent
   conversation gives every attendee two direct channels. This dedupes by person, not by channel
   row, or a conversation with more than one agent would double-count everyone in it. The
   conversation's own agents are excluded, since they are the other side of every direct channel,
   never an attendee themselves. Reads the conversation's own channels list (not a database-wide
   Channel query), so a channel belonging to a different conversation can never be counted here. */
async function countChannelParticipants(conversation): Promise<number> {
  const agentIds = new Set((conversation.agents ?? []).map(agentIdOf))
  const channelIds = conversation.channels ?? []
  if (channelIds.length === 0) return 0

  const directChannels = await Channel.find({ _id: { $in: channelIds }, direct: true }).select('participants')

  const humanIds = new Set<string>()
  for (const channel of directChannels) {
    for (const participant of channel.participants ?? []) {
      const id = participant.toString()
      if (!agentIds.has(id)) humanIds.add(id)
    }
  }
  return humanIds.size
}

/* Bridges the exact poster count with the exact participant count (distinct people who
   joined via a direct channel, see countChannelParticipants). Always returns a real
   engagement bundle, since a channel-based headcount is always computable, unlike the
   web-analytics fetch this replaced, which might simply not have run yet.

   When more people posted than joined, the two counts do not reconcile: either they come
   from different systems in a mixed-platform event, or a poster's join was never recorded
   (a pipeline gap, or a conversation predating this counting method), so we do not invent
   numbers. lurkerCount and participationRate are null and postersExceedTrackedSessions is
   true, letting the card report the two raw counts and explain the gap as a possibility
   rather than launder an unreconciled signal into a confident "0 lurkers, 100%
   participation". When the counts do reconcile, lurkerCount and participationRate are real
   and the flag is false. */
function computeAudienceEngagement(posterCount: number, participantCount: number): AudienceEngagement {
  if (posterCount > participantCount) {
    return {
      participantCount,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    }
  }

  if (participantCount === 0) {
    /* Zero participants is an empty room, not a room where nobody spoke. Report neither
       lurkers nor a rate so the card does not imply 0% of the audience participated when
       there was no audience to begin with. */
    return {
      participantCount,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: false
    }
  }

  return {
    participantCount,
    lurkerCount: participantCount - posterCount,
    participationRate: posterCount / participantCount,
    postersExceedTrackedSessions: false
  }
}

/* Looks at up to the 10 most recent past events in the same topic and builds two
   things: a chart-ready history (each past event labeled by its name and date, this
   event labeled "Today") and a baseline
   that averages their poster counts, lurker counts, and dwell time.

   Past events are read from their persisted ConversationMetricsSnapshot, not recomputed from raw
   messages: each event's numbers were frozen when its recap was built, so a recurring
   series is compared to what it actually was then rather than re-derived on every recap.
   Only snapshots on the current METRICS_VERSION are read, so a metric whose definition
   changed never makes a trend read as one continuous line. Experimental events are never
   snapshotted (the write skips them), so they need no filtering here. The current (live)
   event has no snapshot yet, so its numbers are passed in and appended as "Today".

   A past event's lurker count is whatever was stored: non-null only when that event's
   tracking reconciled against its poster count (the same rule the current event uses), and
   null when it had no tracked data or its posters exceeded its tracked visitors. An event
   with a null lurker count still contributes its poster count but is left out of the dwell
   average. The baseline is null on a topic's first event, since there is nothing earlier to
   compare against (and nothing earlier to have a snapshot).

   The baseline carries two different spans because the averages cover different sets of
   past events. eventCount is the poster span: every past snapshot has a poster count.
   trackedEventCount is the tracked span: only snapshots whose tracking reconciled carry a
   lurker count and a dwell time, so avgLurkerCount and avgDwellSeconds are averaged over
   just those (pastLurkerCounts.length, which equals pastDwells.length since both are gated
   on the same non-null lurker condition). trackedEventCount can be smaller than eventCount,
   so it is reported separately rather than letting a reader assume the lurker and dwell
   averages span every past event. */
async function computeHistoryAndBaseline(
  conversation,
  current: { posterCount: number; lurkerCount: number | null }
): Promise<{ participationHistory: ParticipationHistoryPoint[]; baseline: SameTopicBaseline | null }> {
  const recentPast = await ConversationMetricsSnapshot.find({
    topicId: conversation.topic,
    conversationId: { $ne: conversation._id },
    metricsVersion: METRICS_VERSION,
    endTime: { $exists: true, $ne: null }
  })
    .sort({ endTime: -1 })
    .limit(BASELINE_EVENT_LIMIT)
    .select('name endTime posterCount lurkerCount avgDwellSeconds')

  const oldestFirst = [...recentPast].reverse()
  const participationHistory: ParticipationHistoryPoint[] = []
  const pastPosterCounts: number[] = []
  const pastLurkerCounts: number[] = []
  const pastDwells: number[] = []

  for (const snapshot of oldestFirst) {
    const { posterCount } = snapshot
    const lurkerCount = snapshot.lurkerCount ?? null
    pastPosterCounts.push(posterCount)

    /* A non-null lurker count means that event's tracking reconciled, so its stored dwell is
       a clean audience comparison. Gate both samples on that one condition so the lurker and
       dwell baselines span one identical set of past events (trackedEventCount). A reconciled
       snapshot always carries a dwell number, so the ?? 0 only guards a malformed document and
       keeps pastDwells.length equal to pastLurkerCounts.length. */
    if (lurkerCount !== null) {
      pastLurkerCounts.push(lurkerCount)
      pastDwells.push(snapshot.avgDwellSeconds ?? 0)
    }

    participationHistory.push({
      label: eventDateLabel(snapshot.name, snapshot.endTime, 'Past event'),
      posterCount,
      lurkerCount
    })
  }
  participationHistory.push({ label: 'Today', posterCount: current.posterCount, lurkerCount: current.lurkerCount })

  const baseline = pastPosterCounts.length
    ? {
        eventCount: pastPosterCounts.length,
        trackedEventCount: pastLurkerCounts.length,
        avgPosterCount: average(pastPosterCounts),
        avgLurkerCount: pastLurkerCounts.length ? average(pastLurkerCounts) : null,
        avgDwellSeconds: pastDwells.length ? average(pastDwells) : null
      }
    : null

  return { participationHistory, baseline }
}

/* Builds this event's cross-topic peer comparison (see PeerBaseline). Unlike the same-topic
   baseline above, a peer can come from any topic, so its numbers are only safe to read into
   another topic's card when that peer's own topic is public: the same privacy gate summon and
   trend already enforce (toPublicCandidates in vibesAnalyst/eventResolution). This queries
   candidate snapshots by band, platform, and metrics version first, then joins to Conversation
   and Topic to drop anything from a private topic, so a private series's numbers can never
   surface inside a different topic's peer comparison. Returns null when fewer than
   PEER_COHORT_MIN_EVENTS public peers qualify. */
async function computePeerBaseline(
  conversation,
  current: { posterCount: number; eventPlatform: EventPlatform }
): Promise<PeerBaseline | null> {
  const band = attendanceBandFor(current.posterCount)
  const { min, max } = attendanceBandRange(band)
  const posterCountFilter: Record<string, number> = { $gte: min }
  if (max !== null) posterCountFilter.$lte = max

  const candidates = await ConversationMetricsSnapshot.find({
    conversationId: { $ne: conversation._id },
    metricsVersion: METRICS_VERSION,
    platform: current.eventPlatform,
    posterCount: posterCountFilter,
    endTime: { $exists: true, $ne: null }
  })
    .sort({ endTime: -1 })
    .limit(PEER_COHORT_CANDIDATE_LIMIT)
    .select('conversationId posterCount participationRate participationConcentration')

  if (candidates.length === 0) return null

  const candidateConversations = await Conversation.find({ _id: { $in: candidates.map((c) => c.conversationId) } })
    .populate('topic')
    .select('topic')
  const publicConversationIds = new Set(
    candidateConversations
      .filter((candidate) => candidate.topic?.private === false)
      .map((candidate) => candidate._id.toString())
  )

  const publicPeers = candidates
    .filter((candidate) => publicConversationIds.has(candidate.conversationId.toString()))
    .slice(0, PEER_COHORT_EVENT_LIMIT)

  if (publicPeers.length < PEER_COHORT_MIN_EVENTS) return null

  const posterCounts = publicPeers.map((peer) => peer.posterCount)
  const participationRates = publicPeers
    .map((peer) => peer.participationRate)
    .filter((rate): rate is number => rate !== null && rate !== undefined)
  const topPosterShares = publicPeers
    .map((peer) => peer.participationConcentration?.topPosterMessageShare)
    .filter((share): share is number => share !== null && share !== undefined)

  return {
    band,
    eventCount: publicPeers.length,
    avgPosterCount: average(posterCounts),
    avgParticipationRate: participationRates.length ? average(participationRates) : null,
    participationRateEventCount: participationRates.length,
    avgTopPosterMessageShare: topPosterShares.length ? average(topPosterShares) : null,
    concentrationEventCount: topPosterShares.length
  }
}

/* True when the event names at least one analytics source to pull data from.
   analyticsRefs can arrive as a Mongoose Map or a plain object, so we handle both.
   This is how we tell "no data because nothing was tracked" apart from "no data
   because the fetch has not run yet". */
function hasAnalyticsRef(conversation): boolean {
  const refs = conversation.analyticsRefs
  if (!refs) return false
  return refs instanceof Map ? refs.size > 0 : Object.keys(refs).length > 0
}

function trackedSessionStatusFor(sources: TrackedSessionMetrics[], conversation): TrackedSessionStatus {
  if (sources.length > 0) return 'available'
  return hasAnalyticsRef(conversation) ? 'unavailable' : 'notTracked'
}

/**
 * Gathers every number the recap card and the curating LLM need for one event.
 * Participation always comes from our own database. Tracked sessions come from any
 * stored analytics summaries (one per source) and are kept as a separate layer, so
 * exact first-party counts are never mixed with provider estimates that can
 * undercount. trackedSessionStatus tells the card whether missing session data
 * means "nothing was tracked" or "not available yet".
 */
/* Counts the event's readings and references from what participants could see. Only
   participant-visible resources count, since the recap is about the audience's experience;
   participantVisible defaults to true, so a resource counts unless it is explicitly hidden.
   The counts cover how many readings existed and how many carried a link, never whether
   anyone opened them. Resources are embedded on the conversation, so this needs no query. */
export function computeResourceSummary(conversation: {
  resources?: { category?: string; url?: string; participantVisible?: boolean }[]
}): ResourceSummary {
  const visible = (conversation.resources ?? []).filter((resource) => resource.participantVisible !== false)
  return {
    total: visible.length,
    required: visible.filter((resource) => resource.category === 'required').length,
    referenced: visible.filter((resource) => resource.category === 'referenced').length,
    suggested: visible.filter((resource) => resource.category === 'suggested').length,
    withLinks: visible.filter((resource) => typeof resource.url === 'string' && resource.url.trim().length > 0).length
  }
}

/* Derives which platform(s) the event ran on from the conversation's platforms list, the
   source of truth set at creation. 'both' when Nextspace and Zoom ran together. Defaults to
   'nextspace' when nothing is recorded, since that is where the recap is read. */
export function deriveEventPlatform(conversation: { platforms?: string[] }): EventPlatform {
  const platforms = conversation.platforms ?? []
  const hasZoom = platforms.includes('zoom')
  const hasNextspace = platforms.includes('nextspace')
  if (hasZoom && hasNextspace) return 'both'
  if (hasZoom) return 'zoom'
  return 'nextspace'
}

async function computeConversationMetrics(conversation): Promise<ConversationMetrics> {
  const participation = await computeParticipation(conversation._id)
  const snapshots = await ConversationAnalytics.find({ conversationId: conversation._id })
  const trackedSessionSources = snapshots.map(deriveTrackedSessions)
  const channelParticipantCount = await countChannelParticipants(conversation)
  const audienceEngagement = computeAudienceEngagement(participation.posterCount, channelParticipantCount)
  const humanMessages = await Message.find({
    conversation: conversation._id,
    ...visibleHumanFilter
  })
    .select('createdAt channels owner pseudonymId parentMessage')
    .sort({ createdAt: 1 })
  const channelNames = [...new Set(humanMessages.flatMap((message) => message.channels ?? []))]
  const directNames = await resolveDirectNames(channelNames)
  const activityBuckets = bucketMessagesOverTime(humanMessages, conversation.startTime, conversation.endTime)
  const channelSplit = computeChannelSplit(humanMessages, directNames)
  const privateMessaging = computePrivateMessaging(humanMessages, directNames, participation.posterCount)
  const timeToFirstMessage = computeTimeToFirstMessage(humanMessages, directNames, conversation.startTime)
  const replyLatency = computeReplyLatency(humanMessages)
  const participationConcentration = computeParticipationConcentration(humanMessages)
  const interactionStructure = computeInteractionStructure(humanMessages)
  const spikes = attributeSpikeSources(
    computeSpikes(activityBuckets, participation.posterCount),
    humanMessages,
    conversation.startTime,
    directNames
  )
  const botInvocations = await computeBotInvocations(conversation)
  const { participationHistory, baseline } = await computeHistoryAndBaseline(conversation, {
    posterCount: participation.posterCount,
    lurkerCount: audienceEngagement.lurkerCount
  })
  const eventPlatform = deriveEventPlatform(conversation)
  const peerBaseline = await computePeerBaseline(conversation, { posterCount: participation.posterCount, eventPlatform })

  return {
    participation,
    trackedSessionSources,
    trackedSessionStatus: trackedSessionStatusFor(trackedSessionSources, conversation),
    audienceEngagement,
    activitySeries: toActivitySeries(activityBuckets),
    spikes,
    participationHistory,
    baseline,
    peerBaseline,
    channelSplit,
    privateMessaging,
    timeToFirstMessage,
    replyLatency,
    participationConcentration,
    interactionStructure,
    botInvocations,
    resourceSummary: computeResourceSummary(conversation),
    eventPlatform,
    // Filled by the Vibes Analyst from message content; the service leaves it empty.
    receptions: []
  }
}

const conversationAnalyticsService = {
  computeConversationMetrics
}

export default conversationAnalyticsService
