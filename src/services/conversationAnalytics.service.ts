import Message from '../models/message.model.js'
import Channel from '../models/channel.model.js'
import Conversation from '../models/conversation.model.js'
import ConversationAnalytics from '../models/conversationAnalytics.model.js'
import {
  ActivityBucket,
  AudienceEngagement,
  ConversationMetrics,
  ParticipationHistoryPoint,
  ParticipationMetrics,
  SameTopicBaseline,
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

/* The baseline averages at most this many recent past events in the same topic, so
   a long-running series is compared to its recent average rather than all of it. */
const BASELINE_EVENT_LIMIT = 10

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
   active when it was sent. Grouping by pseudonym would therefore count one person who
   renamed mid-event as several distinct posters and overcount the room. owner is
   required:false on the schema, so we fall back to pseudonym when it is missing. */
async function computeParticipation(conversationId): Promise<ParticipationMetrics> {
  const byPoster: { _id: string; count: number }[] = await Message.aggregate([
    { $match: { conversation: conversationId, ...visibleHumanFilter } },
    { $group: { _id: { $ifNull: ['$owner', '$pseudonym'] }, count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ])

  const posterCount = byPoster.length
  const messageCount = byPoster.reduce((sum, poster) => sum + poster.count, 0)

  // Top 10% of posters, rounded up, but always at least one once anyone has posted.
  const frequentPosterCount = posterCount > 0 ? Math.max(1, Math.ceil(posterCount * 0.1)) : 0
  const frequentPosterMessages = byPoster.slice(0, frequentPosterCount).reduce((sum, poster) => sum + poster.count, 0)
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
   definition, so nothing is dropped. Returns [] when no messages land in the
   window. */
function computeActivitySeries(messages: { createdAt?: Date }[], startTime?: Date, endTime?: Date): ActivityBucket[] {
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
    return [{ label: '0-0', messageCount: inWindow.length }]
  }

  const bucketSizeMinutes = Math.ceil(totalMinutes / ACTIVITY_BUCKET_COUNT)
  const buckets: ActivityBucket[] = []
  for (let index = 0; index < ACTIVITY_BUCKET_COUNT; index += 1) {
    const bucketStart = index * bucketSizeMinutes
    if (bucketStart >= totalMinutes) break
    const bucketEnd = Math.min(bucketStart + bucketSizeMinutes, totalMinutes)
    buckets.push({ label: `${bucketStart}-${bucketEnd}`, messageCount: 0 })
  }

  for (const message of inWindow) {
    const minutesFromStart = (message.createdAt.getTime() - startMs) / 60000
    const index = Math.min(Math.max(Math.floor(minutesFromStart / bucketSizeMinutes), 0), buckets.length - 1)
    buckets[index].messageCount += 1
  }

  return buckets
}

/* Counts people's messages as either public chat or private (one-to-one with the
   bot). A message is private when it was sent in a "direct" channel, which is how
   the database marks a private 1:1 channel between a person and the agent. */
async function computeChannelSplit(conversationId): Promise<{ public: number; private: number }> {
  const messages = await Message.find({
    conversation: conversationId,
    ...visibleHumanFilter
  }).select('channels')
  const channelNames = [...new Set(messages.flatMap((message) => message.channels ?? []))]
  const directChannels = await Channel.find({ name: { $in: channelNames }, direct: true }).select('name')
  const directNames = new Set(directChannels.map((channel) => channel.name))

  let publicCount = 0
  let privateCount = 0
  for (const message of messages) {
    if ((message.channels ?? []).some((name) => directNames.has(name))) privateCount += 1
    else publicCount += 1
  }
  return { public: publicCount, private: privateCount }
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

/* Looks at up to the 10 most recent past events in the same topic and builds two
   things: a chart-ready history (oldest is "E1", this event is "Today") and a baseline
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
    .select('_id')

  const oldestFirst = [...recentPast].reverse()
  const participationHistory: ParticipationHistoryPoint[] = []
  const pastPosterCounts: number[] = []
  const pastLurkerCounts: number[] = []
  const pastDwells: number[] = []

  for (const [index, pastEvent] of oldestFirst.entries()) {
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

    participationHistory.push({ label: `E${index + 1}`, posterCount, lurkerCount })
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
async function computeConversationMetrics(conversation): Promise<ConversationMetrics> {
  const participation = await computeParticipation(conversation._id)
  const snapshots = await ConversationAnalytics.find({ conversationId: conversation._id })
  const trackedSessionSources = snapshots.map(deriveTrackedSessions)
  const audienceEngagement = computeAudienceEngagement(participation.posterCount, trackedSessionSources)
  const humanMessages = await Message.find({
    conversation: conversation._id,
    ...visibleHumanFilter
  })
    .select('createdAt')
    .sort({ createdAt: 1 })
  const channelSplit = await computeChannelSplit(conversation._id)
  const { participationHistory, baseline } = await computeHistoryAndBaseline(conversation, {
    posterCount: participation.posterCount,
    lurkerCount: audienceEngagement ? audienceEngagement.lurkerCount : null
  })

  return {
    participation,
    trackedSessionSources,
    trackedSessionStatus: trackedSessionStatusFor(trackedSessionSources, conversation),
    audienceEngagement,
    activitySeries: computeActivitySeries(humanMessages, conversation.startTime, conversation.endTime),
    participationHistory,
    baseline,
    channelSplit
  }
}

const conversationAnalyticsService = {
  computeConversationMetrics
}

export default conversationAnalyticsService
