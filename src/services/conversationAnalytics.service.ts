import Message from '../models/message.model.js'
import Channel from '../models/channel.model.js'
import Conversation from '../models/conversation.model.js'
import ConversationAnalytics from '../models/conversationAnalytics.model.js'
import { matchBotMention } from '../agents/helpers/intentChecks.js'
import config from '../config/config.js'
import {
  ActivityBucket,
  AudienceEngagement,
  BotInvocations,
  ChatSpike,
  ConversationMetrics,
  EventPlatform,
  ParticipationHistoryPoint,
  ParticipationMetrics,
  ResourceSummary,
  SameTopicBaseline,
  SpikeSource,
  TrackedSessionMetrics,
  TrackedSessionStatus
} from '../types/index.types.js'

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
   meaningless, so the frequent-poster share is reported as null instead. */
const FREQUENT_POSTER_MIN_POSTERS = 5

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

/* Converts one stored analytics summary (a ConversationAnalytics document: raw
   visit/dwell counts from a provider like Matomo) into the numbers the card shows.
   Averages and rates are computed here and never saved. A summary with zero visits
   yields 0 instead of NaN. */
function deriveTrackedSessions(snapshot): TrackedSessionMetrics {
  const totalVisits = snapshot.totalVisits ?? 0
  return {
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
    trackedSessions: totalVisits,
    attendeeCount: snapshot.attendeeCount ?? 0,
    avgDwellSeconds: totalVisits > 0 ? (snapshot.totalDwellSeconds ?? 0) / totalVisits : 0,
    totalActions: snapshot.totalActions ?? 0,
    deviceBreakdown: (snapshot.deviceBreakdown as Record<string, number>) ?? {}
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

/* Bridges the exact poster count with the estimated participant count (unique
   tracked-session visitors from the primary source). Returns null when there is no
   tracked-session data, since without a participant count there is no denominator.

   When more people posted than were tracked as sessions, the two counts come from
   different systems and do not reconcile, so we do not invent numbers. lurkerCount and
   participationRate are null and postersExceedTrackedSessions is true, letting the card
   report the two raw counts and explain the gap as a possibility rather than launder an
   unreconciled signal into a confident "0 lurkers, 100% participation". When the counts
   do reconcile, lurkerCount and participationRate are real and the flag is false. */
function computeAudienceEngagement(posterCount: number, sources: TrackedSessionMetrics[]): AudienceEngagement | null {
  const [primary] = sources
  if (!primary) return null

  const participantCount = primary.attendeeCount

  if (posterCount > participantCount) {
    return {
      participantCount,
      lurkerCount: null,
      participationRate: null,
      postersExceedTrackedSessions: true
    }
  }

  if (participantCount === 0) {
    /* A tracked snapshot with zero visitors is an empty room, not a room where nobody
       spoke. Report neither lurkers nor a rate so the card does not imply 0% of the
       audience participated when there was no audience to begin with. */
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

/* Month abbreviations for a compact event date label, indexed by getUTCMonth(). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/* A history point's label: the event's own name plus a short date, e.g. "Future of Work
   (Jun 3)". A topic's events often share a name (a recurring series), so the date sets
   most of them apart and reads better than an opaque "E1". Two same-named events on the
   same day still share a label, which is rare enough to accept. Falls back to the date
   alone when an event has no name. The date is the UTC calendar day, so it is
   deterministic but can read a day off for a viewer in a far timezone. */
function eventHistoryLabel(name: string | undefined, endTime: Date | undefined): string {
  const date = endTime ? `${MONTHS[endTime.getUTCMonth()]} ${endTime.getUTCDate()}` : ''
  const trimmedName = name?.trim()
  if (trimmedName && date) return `${trimmedName} (${date})`
  return trimmedName || date || 'Past event'
}

/* Looks at up to the 10 most recent past events in the same topic and builds two
   things: a chart-ready history (each past event labeled by its name and date, this
   event labeled "Today") and a baseline
   that averages their poster counts, lurker counts, and dwell time. A past event's
   lurker count and dwell only count when it has stored tracked-session data AND its
   participation reconciles, meaning its poster count did not exceed its tracked visitor
   count, which is the same rule the current event uses. An event that lacks tracked data,
   or whose posters exceed tracked visitors, still contributes its poster count but leaves
   lurkers unknown (null) and is left out of the dwell average. The baseline is null on a
   topic's first event, since there is nothing earlier to compare against.

   The baseline carries two different spans because the averages cover different sets of
   past events. eventCount is the poster span: every past event has a known poster count.
   trackedEventCount is the tracked span: only events with stored tracked-session data that
   also reconciled contribute a lurker count and a dwell time, so avgLurkerCount and
   avgDwellSeconds are averaged over just those (pastLurkerCounts.length, which equals
   pastDwells.length since both are gated on the same reconciles condition).
   trackedEventCount can be smaller than eventCount, so it is reported separately rather
   than letting a reader assume the lurker and dwell averages span every past event. */
async function computeHistoryAndBaseline(
  conversation,
  current: { posterCount: number; lurkerCount: number | null }
): Promise<{ participationHistory: ParticipationHistoryPoint[]; baseline: SameTopicBaseline | null }> {
  /* experimental conversations are test runs, not real events, so they are excluded
     from the baseline to match how the rest of the codebase scopes real events. */
  const recentPast = await Conversation.find({
    topic: conversation.topic,
    _id: { $ne: conversation._id },
    endTime: { $exists: true, $ne: null },
    experimental: { $ne: true }
  })
    .sort({ endTime: -1 })
    .limit(BASELINE_EVENT_LIMIT)
    .select('_id name endTime')

  const oldestFirst = [...recentPast].reverse()
  const participationHistory: ParticipationHistoryPoint[] = []
  const pastPosterCounts: number[] = []
  const pastLurkerCounts: number[] = []
  const pastDwells: number[] = []

  for (const pastEvent of oldestFirst) {
    const { posterCount } = await computeParticipation(pastEvent._id)
    pastPosterCounts.push(posterCount)

    const snapshot = await ConversationAnalytics.findOne({ conversationId: pastEvent._id })
    const hasTracked = !!snapshot && (snapshot.totalVisits ?? 0) > 0
    /* Apply the same reconciliation rule the current event uses: a past event reconciles
       only when it has tracked data AND its tracked visitor count is at least its poster
       count. When more people posted than were tracked, the two counts come from different
       systems and do not reconcile, so we do not invent a lurker count. The >= posterCount
       guard means the difference is never negative, which is why no Math.max clamp is needed. */
    const reconciles = hasTracked && (snapshot.attendeeCount ?? 0) >= posterCount
    const lurkerCount = reconciles ? (snapshot.attendeeCount ?? 0) - posterCount : null
    if (lurkerCount !== null) pastLurkerCounts.push(lurkerCount)
    /* Gate the dwell sample on reconciliation too, not just on hasTracked. If participation
       and tracking did not reconcile, the event's tracking under-captured the audience, so it
       is not a clean audience comparison for dwell either. Dropping it from both keeps the
       lurker and dwell baselines over one identical span of past events (trackedEventCount). */
    if (reconciles) pastDwells.push((snapshot.totalDwellSeconds ?? 0) / snapshot.totalVisits)

    participationHistory.push({ label: eventHistoryLabel(pastEvent.name, pastEvent.endTime), posterCount, lurkerCount })
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
  const audienceEngagement = computeAudienceEngagement(participation.posterCount, trackedSessionSources)
  const humanMessages = await Message.find({
    conversation: conversation._id,
    ...visibleHumanFilter
  })
    .select('createdAt channels')
    .sort({ createdAt: 1 })
  const channelNames = [...new Set(humanMessages.flatMap((message) => message.channels ?? []))]
  const directNames = await resolveDirectNames(channelNames)
  const activityBuckets = bucketMessagesOverTime(humanMessages, conversation.startTime, conversation.endTime)
  const channelSplit = computeChannelSplit(humanMessages, directNames)
  const spikes = attributeSpikeSources(
    computeSpikes(activityBuckets, participation.posterCount),
    humanMessages,
    conversation.startTime,
    directNames
  )
  const botInvocations = await computeBotInvocations(conversation)
  const { participationHistory, baseline } = await computeHistoryAndBaseline(conversation, {
    posterCount: participation.posterCount,
    lurkerCount: audienceEngagement ? audienceEngagement.lurkerCount : null
  })

  return {
    participation,
    trackedSessionSources,
    trackedSessionStatus: trackedSessionStatusFor(trackedSessionSources, conversation),
    audienceEngagement,
    activitySeries: toActivitySeries(activityBuckets),
    spikes,
    participationHistory,
    baseline,
    channelSplit,
    botInvocations,
    resourceSummary: computeResourceSummary(conversation),
    eventPlatform: deriveEventPlatform(conversation),
    // Filled by the Vibes Analyst from message content; the service leaves it empty.
    receptions: []
  }
}

const conversationAnalyticsService = {
  computeConversationMetrics
}

export default conversationAnalyticsService
