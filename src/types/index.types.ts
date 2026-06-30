import { z } from 'zod'

import mongoose from 'mongoose'

export interface PaginateResults<T> {
  results: Array<T>
  page: number
  limit: number
  totalPages: number
  totalResults: number
}

export interface IPseudonym {
  _id?: mongoose.Types.ObjectId
  token: string
  pseudonym: string
  active: boolean
  isDeleted: boolean
  conversations: string[]
  funFact?: string
}

export interface IBaseUser {
  _id?: mongoose.Types.ObjectId
  activePseudonym?: IPseudonym
  __t?: string
}

export interface IUserPreferences {
  visualResponse?: boolean
  jargonClarification?: boolean
}

export interface IUser {
  goodReputation?: boolean
  role?: string
  password: string
  email?: string
  username: string
  dataExportOptOut?: boolean
  pseudonyms: mongoose.Types.DocumentArray<IPseudonym>
  preferences?: IUserPreferences
}

export interface ITopic {
  _id?: mongoose.Types.ObjectId
  id?: string
  slug?: string
  name: string
  description?: string
  defaultSortAverage?: number
  followed?: boolean
  conversations: IConversation[]
  votingAllowed: boolean
  owner: IUser
  conversationCreationAllowed: boolean
  private: boolean
  passcode?: number
  archivable: boolean
  archived?: boolean
  isDeleted?: boolean
  isArchiveNotified?: boolean
  archiveEmail?: string
  followers: IFollower[]
  latestMessageCreatedAt?: Date
  messageCount?: number
  conversationCount?: number
}

export interface Vote {
  owner?: IUser
  pseudonym?: string
  reason?: string
}

export interface PromptOption {
  value: string
  label: string
  description?: string
}

export interface MessagePrompt {
  type: 'multipleChoice' | 'singleChoice' | 'text' | 'number' | 'date' | 'custom'
  options?: PromptOption[]
  placeholder?: string
  validation?: {
    required?: boolean
    min?: number
    max?: number
    pattern?: string
  }
}

export interface IMessage {
  _id?: mongoose.Types.ObjectId
  owner?: IBaseUser
  body: string | Record<string, unknown>
  bodyType?: string
  source?: { type: string; id?: string; [key: string]: unknown }
  channels?: string[]
  conversation: IConversation
  fromAgent: boolean
  pause: number
  visible: boolean
  count?: number
  pseudonym: string
  pseudonymId: mongoose.Types.ObjectId
  active?: boolean
  isDeleted?: boolean
  upVotes: Vote[]
  downVotes: Vote[]
  parentMessage?: mongoose.Types.ObjectId
  answersPrompt?: mongoose.Types.ObjectId
  createdAt?: Date
  updatedAt?: Date
  replyCount?: number
  prompt?: MessagePrompt
  /* Adapter-specific rich content (e.g. Slack Block Kit). Persisted so the
     Slack adapter can read it when forwarding the message to Slack's API.
     Kept as unknown[] to avoid platform-specific types in the shared model. */
  blocks?: unknown[]
  /* Neutral render instruction persisted alongside blocks. The Slack adapter
     renders responseKind + renderData into blocks when sending. */
  responseKind?: string
  renderData?: unknown
}

export interface IFollower {
  user: mongoose.Types.ObjectId
  conversation: mongoose.Types.ObjectId
  topic: mongoose.Types.ObjectId
}

export const ChannelZodSchema = z.object({
  name: z.string(),
  passcode: z.string().nullable(),
  direct: z.boolean(),
  participants: z.array(z.any()).optional()
})

export enum Direction {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
  BOTH = 'both'
}

export interface IChannel {
  _id?: mongoose.Types.ObjectId
  name: string
  passcode: string | null
  direct: boolean
  participants?: IBaseUser[]
}

export interface AdapterChannelConfig {
  direct?: boolean
  agent?: mongoose.Types.ObjectId | string
  name?: string
  direction: Direction
  config?: Record<string, unknown>
  users?: string
}

export interface IAdapter {
  _id?: mongoose.Types.ObjectId
  type: string
  config: Record<string, unknown>
  conversation: IConversation
  active: boolean
  audioChannels?: AdapterChannelConfig[]
  chatChannels?: AdapterChannelConfig[]
  dmChannels?: AdapterChannelConfig[]
}

export interface IExperiment {
  name: string
  description?: string
  baseConversation: IConversation
  createdBy: IUser
  createdAt: Date
  status: 'running' | 'completed' | 'failed' | 'not started'
  agentModifications?: {
    agent: IAgent
    experimentValues?: Record<string, unknown> // should match properties object of agentType passed in on Conversation creation
    simulatedStartTime?: Date // The Date of the earliest message considered in the periodic interval
  }[]
  resultConversation?: IConversation
  executedAt?: Date
}

export interface ConfigProperty {
  name: string
  as?: string // destination key (supports dot notation for nesting); defaults to name
  required: boolean
  type: 'string' | 'number' | 'boolean' | 'object' | 'enum'
  label?: string
  default?: string | number | boolean | object
  description?: string
  options?: Array<object>
  validationKeys?: string[]
  itemKey?: string
  schema?: Array<object>
}

export interface PropertyRef {
  $ref: string // dot-notation path into resolved properties (including feature sub-objects)
  as?: string // destination key in agent params (supports dot notation for nesting); defaults to last segment of $ref
}

export type AgentProperty = ConfigProperty | PropertyRef

export interface ChannelConfig {
  name: string
  passcode?: string | null
  direct?: boolean
}

export interface AgentConfig {
  name: string
  properties?: AgentProperty[]
}

export interface FeatureAgentConfig {
  name: string // agent type name
  properties?: AgentProperty[] // wiring from resolved properties into agent config
}

/**
 * A feature instance stored on a conversation document.
 *
 * `enabled` is tri-state:
 *   true      = organizer turned this on
 *   false     = organizer turned this off
 *   undefined = conversation predates this feature; falls back to FeatureConfig.default
 *
 * New records should always set `enabled` explicitly. A missing `enabled` field
 * just means the record was written before this field existed.
 */
export interface Feature {
  name: string
  enabled?: boolean
  config?: Record<string, unknown>
}

export interface FeatureConfig {
  name: string
  label: string
  description?: string
  agents: FeatureAgentConfig[]
  default: boolean
  properties?: ConfigProperty[]
  // Which platform area this feature belongs to. Omitting it is a compile error.
  category: 'assistant' | 'group-chat' | 'transcript' | 'resources'
  // Slash command without the leading slash (e.g. "mindmap"). Omit for passive features.
  slashCommand?: string
  // Setup instruction (e.g. how to enable the feature).
  prerequisite?: string
  // Whether the participant can control this feature (toggle or slash command). false = runs automatically.
  userControlled: boolean
  // Present in /features responses. Absent in static type definitions.
  enabled?: boolean
}

export interface PlatformConfig {
  name: string
  label?: string
}

export interface AdapterConfig {
  type: string
  config?: Record<string, unknown>
  audioChannels?: AdapterChannelConfig[]
  chatChannels?: AdapterChannelConfig[]
  dmChannels?: AdapterChannelConfig[]
}

export interface ConversationType {
  name: string
  label?: string
  description: string
  platforms: PlatformConfig[]
  properties: ConfigProperty[]
  features?: FeatureConfig[]
  agents?: AgentConfig[]
  channels?: ChannelConfig[]
  enableDMs?: string[]
  adapters?: Record<string, AdapterConfig>
}

export interface Profile {
  name: string
  bio?: string
  alternateName?: string
}

export interface ITranscript {
  vectorStore?: {
    embeddingsPlatform: string
    embeddingsModelName: string
  }
  status: 'active' | 'paused' | 'stopped' | 'deleted'
}

export interface Resource {
  _id?: mongoose.Types.ObjectId
  source: 'speaker' | 'ai'
  category: 'required' | 'referenced' | 'suggested'
  title: string
  authors?: string[]
  year?: string
  url?: string
  fileName?: string // on-disk name; present when resource is a PDF file (private — stripped from API responses)
  hasPdf?: boolean // derived from fileName; true when a PDF is attached
  citation?: string // full formatted citation
  description?: string // creator-provided relevance note
  summary?: string // AI-generated; populated async for required readings
  relevanceReason?: string // librarian one-liner
  participantVisible: boolean
  addedAt?: Date
}

export interface IConversation {
  _id?: mongoose.Types.ObjectId
  messages: Array<IMessage>
  slug?: string
  name: string
  description?: string
  conversationType?: string
  platforms?: string[]
  moderators?: Profile[]
  presenters?: Profile[]
  followers: Array<IFollower>
  agents: Array<IAgent>
  channels: Array<IChannel>
  scheduledTime?: Date
  scheduledEndTime?: Date
  startTime?: Date
  endTime?: Date
  adapters: Array<IAdapter>
  enableDMs: string[]
  experimental?: boolean
  analyticsRefs?: Map<string, string> // Which analytics source(s) hold this event's data, by name, e.g. { matomo: "<segment id>" }.
  experiments: IExperiment[]
  properties?: Record<string, unknown>
  features?: Feature[]
  active?: boolean
  locked?: boolean
  enableAgents?: boolean
  owner: IUser
  topic: ITopic
  transcript?: ITranscript
  followed?: boolean
  resources: Resource[]
  createdAt?: Date
  updatedAt?: Date
  messageCount(): number
  summary?: string
}

export interface IPoll {
  title: string
  slug: string
  description?: string
  locked: boolean
  owner: IUser
  threshold?: number
  expirationDate?: Date
  conversation: IConversation
  multiSelect: boolean
  allowNewChoices: boolean
  choicesVisible: boolean
  responseCountsVisible: boolean
  onlyOwnChoicesVisible: boolean
  whenResultsVisible: string
  responsesVisibleToNonParticipants: boolean
  responsesVisible: boolean
  choices?: IPollChoice[]
}

export type PollConfig = Partial<
  Pick<
    IPoll,
    | 'multiSelect'
    | 'allowNewChoices'
    | 'choicesVisible'
    | 'responseCountsVisible'
    | 'onlyOwnChoicesVisible'
    | 'whenResultsVisible'
    | 'responsesVisible'
    | 'responsesVisibleToNonParticipants'
    | 'threshold'
    | 'expirationDate'
  >
>

export interface IPollChoice {
  _id?: mongoose.Types.ObjectId
  text: string
  poll: IPoll
}

export interface IPollResponse {
  choice: IPollChoice
  removed: boolean
  owner: IUser
  poll: IPoll
}

export interface PollResponseModel extends mongoose.Model<IPollResponse> {
  replaceObjectsWithIds(pollResponse: IPollResponse): IPollResponse
}

/**
 * ====================================
 *
 * Agent related types go below
 *
 * ====================================
 */

/**
 * @enum {number}
 */
export const AgentMessageActions = {
  OK: 0,
  REJECT: 1,
  CONTRIBUTE: 2
}

export type AgentMessageAction = (typeof AgentMessageActions)[keyof typeof AgentMessageActions]

export const AgentMessageActionSchema = z.nativeEnum(AgentMessageActions)

export interface AgentEvaluation {
  action: AgentMessageAction
}

export const AgentResponseZodSchema = z.object({
  visible: z.boolean(),
  message: z.union([z.string(), z.record(z.unknown())]),
  messageType: z.enum(['text', 'json', 'multimodal']).optional(),
  channels: z.array(ChannelZodSchema).optional(),
  responseKind: z.string().optional(),
  renderData: z.unknown().optional()
})

export interface AgentResponse<T> {
  visible: boolean
  message: T
  channels?: IChannel[]
  messageType?: string
  context?: string
  replyFormat?: MessagePrompt
  parent?: mongoose.Types.ObjectId
  pause?: number
  /* Adapter-specific rich content (e.g. Slack Block Kit). Kept as unknown[]
     here to avoid pulling platform-specific types into the shared interface.
     The Slack adapter reads this field when sending a message. */
  blocks?: unknown[]
  /* Platform-neutral render instruction. responseKind names the kind of card
     (e.g. 'curatedVibesSummary'); renderData is the neutral payload. The Slack
     adapter looks up responseKind in its block registry and renders renderData
     into blocks at send time. Other adapters ignore these and send `message`. */
  responseKind?: string
  renderData?: unknown
}

/* The raw counts an analytics source fetcher returns for one event, before we
   stamp the source name and capture time and store them as a ConversationAnalytics
   document. Only additive counts and sums live here; every ratio (average dwell)
   is derived later at read time, never stored. */
export interface AnalyticsSnapshot {
  attendeeCount: number
  totalVisits: number
  totalActions: number
  totalDwellSeconds: number
  deviceBreakdown: Record<string, number>
}

/*
 * Engagement vocabulary (project-wide, use these terms consistently in code, prompts,
 * and the recap):
 *
 * - Participant: anyone who opens the participant link and joins the session in a
 *   browser, whether or not they post. Counted by tracked sessions (the Matomo
 *   visit-scope dimension), because that measures page visits, not accounts.
 * - Lurker: a participant who watches but never posts. Derived as participants minus
 *   posters; only knowable when tracked-session data is available.
 * - Poster: anyone who sends at least one message, in group chat or a direct message
 *   to the bot. Exact, from our own database.
 * - Frequent poster: a poster who posts noticeably more than the typical poster.
 *   Defined as the top 10% of posters by message count (at least one when there are
 *   any posters), along with their share of all messages.
 *
 * Participation rate: posters divided by participants ("what share of the room
 * spoke"). It is APPROXIMATE, because participants comes from tracked sessions, which
 * can undercount. So it is computed only when tracked-session data exists, always
 * labeled as an estimate that may undercount, and clamped/annotated when it exceeds
 * 100% (more posters than tracked visits). Never the old posters-over-followers rate.
 *
 * "Registered" / followers is a SEPARATE, pre-existing platform concept: an explicit,
 * account-based follow of a conversation or topic. It is not the participant
 * denominator for events. Open-link events create no followers, so a follower-based
 * participation rate does not apply to them. Use "poster" for message senders and
 * "participant" for browser visitors, never "registered".
 */

/* Participation, taken from our own database, so it is exact. posterCount is the
   number of distinct people who sent at least one message; messageCount is the total
   non-bot messages. frequentPosterCount is the top 10% of posters by message volume,
   widened to include everyone tied at the cutoff so a boundary tie is not split by sort
   order. frequentPosterMessageShare is the fraction of all messages those frequent
   posters sent (0 to 1), so the card can say whether a few people dominated. Below a
   handful of posters a dominance share is meaningless, so frequentPosterMessageShare is
   null and frequentPosterCount is 0 there. */
export interface ParticipationMetrics {
  posterCount: number
  frequentPosterCount: number
  frequentPosterMessageShare: number | null
  messageCount: number
}

/* Web-analytics numbers for one event from one provider (e.g. Matomo), computed
   from a stored ConversationAnalytics summary. These providers can undercount (see
   nextspace #230), so we call them "tracked sessions" and never treat them as
   exact. We avoid the word "attention" on purpose: session data cannot tell whether
   a person was actually paying attention. Averages and rates are computed when read,
   not stored. */
export interface TrackedSessionMetrics {
  source: string
  capturedAt: Date
  trackedSessions: number
  attendeeCount: number
  avgDwellSeconds: number
  totalActions: number
  deviceBreakdown: Record<string, number>
}

/* The audience-engagement view: how the exact poster count relates to the estimated
   participant count (unique tracked-session visitors). This is the ONE place posters
   (exact) and participants (an estimate that can undercount) are combined, so it is
   always approximate. It is null when no tracked-session data exists, because without a
   participant count there is no denominator.

   When more people posted than were tracked as sessions, the two counts do not
   reconcile: they come from different systems (posters from our database, participants
   from web analytics), so a poster who blocked tracking or joined without a tracked page
   visit can push posterCount past participantCount. In that case we do not invent
   numbers. lurkerCount and participationRate are null and postersExceedTrackedSessions
   is true, so the card can state the two raw counts and explain the gap as a
   possibility rather than show an impossible "0 lurkers, 100% participation".

   When the counts do reconcile (posterCount <= participantCount), lurkerCount is
   participants minus posters, participationRate is posters / participants, and
   postersExceedTrackedSessions is false. */
export interface AudienceEngagement {
  participantCount: number
  lurkerCount: number | null
  participationRate: number | null
  postersExceedTrackedSessions: boolean
}

/* One bar of the activity chart: a time window of the event and how many of the
   people's (non-bot) messages happened in it. */
export interface ActivityBucket {
  label: string
  messageCount: number
}

/* One detected chat spike: a time window whose message volume stood out from the
   rest of the event. startMinute/endMinute are offsets from the event start, so a
   later step can pull the messages sent during the window. baselineAverage is the
   mean message count across the other windows; ratio is messageCount over that
   average, or null when the rest of the event was silent and there is no baseline
   to compare against. */
/* A short, grounded label for what drove a spike. quote is verbatim text from a
   message sent during the spike window, so the card never attributes words no one
   wrote; topic is a brief phrase summarizing it. Present only when a quote was
   confirmed against the window's messages. */
export interface SpikeAnnotation {
  topic: string
  quote: string
}

/* Which channel category drove a spike. 'chat' and 'moderator' are channels the analyst
   is allowed to read, so those spikes can carry a quote. 'private' is a burst of
   one-to-one messages with the bot, which the analyst never reads, so it is surfaced by
   its count alone. */
export type SpikeSource = 'chat' | 'moderator' | 'private'

export interface ChatSpike {
  label: string
  startMinute: number
  endMinute: number
  messageCount: number
  baselineAverage: number
  ratio: number | null
  // Stamped by the service from the window's messages, before any content is read, so the
  // analyst can label a private or backchannel burst without opening those messages.
  source: SpikeSource
  // Filled after detection, once a window quote is confirmed; absent otherwise.
  annotation?: SpikeAnnotation
}

/* One point on the engagement-history chart: a past event in the same topic (or
   "Today"), with how many people posted and how many lurked (watched without posting).
   lurkerCount is null when that event had no tracked-session data, since lurkers can
   only be derived when the participant count is known. */
export interface ParticipationHistoryPoint {
  label: string
  posterCount: number
  lurkerCount: number | null
}

/* The topic's recent average, used to judge whether today was high or low. It averages
   up to the 10 most recent past events in the same topic.

   Two different spans are exposed because the averages cover different sets of past
   events. eventCount is the poster span: every past event has a known poster count, so
   avgPosterCount is averaged over all of them. trackedEventCount is the tracked span:
   only past events with stored web-analytics data contribute a lurker count and a dwell
   time, so avgLurkerCount and avgDwellSeconds are averaged over just those. Both of those
   averages are gated on the same tracked-session condition, so the one count backs both.
   trackedEventCount is therefore at most eventCount and can be smaller, which is why it is
   reported separately rather than implying the lurker and dwell averages span every past
   event. avgLurkerCount and avgDwellSeconds are null when no past event had tracked data
   (trackedEventCount is 0). */
export interface SameTopicBaseline {
  eventCount: number
  trackedEventCount: number
  avgPosterCount: number
  avgLurkerCount: number | null
  avgDwellSeconds: number | null
}

/* How many times participants called on the event's configured assistant by name.
   botName is the name set at event creation (or the default); count is how many
   participant chat messages addressed it, matched the same fuzzy way the assistant
   itself detects a mention. */
export interface BotInvocations {
  botName: string
  count: number
}

/* How the room received one speaker moment. agreement: the chat backed it up;
   pushback: the chat challenged it; mixed: both showed up. The model reads the
   reaction and labels it, but the label only stands when a real reaction quote and
   the volume support it. */
export type ReceptionSentiment = 'agreement' | 'pushback' | 'mixed'

/* A speaker line that drew a visible chat reaction, with how the room responded.
   sparkQuote is verbatim from the transcript; reactionQuote is a verbatim chat reply
   that typifies the response; reactionVolume is how many public chat messages landed
   in the window just after the line. Both quotes are confirmed against their source
   before a reception is kept, so the sentiment never rides on invented words. */
export interface QuoteReception {
  sparkQuote: string
  reactionVolume: number
  reactionQuote: string
  sentiment: ReceptionSentiment
}

/* Whether web-analytics data exists for this event. notTracked: no analytics source
   is set on the event, so nothing was ever tracked. unavailable: a source is set
   but no data has been stored yet (the fetch failed or has not run). available: at
   least one source has stored data. The card uses this to word its "data may be
   limited" note. */
export type TrackedSessionStatus = 'available' | 'notTracked' | 'unavailable'

/* The bundle of numbers the recap card and the curating LLM both read for one
   event. Participation (from our own database) is always present and exact. Tracked
   sessions are a separate layer (one entry per analytics source that has stored
   data) and are never merged into a single combined score. */
export interface ConversationMetrics {
  participation: ParticipationMetrics
  // One entry per analytics source that has stored data; empty when none.
  trackedSessionSources: TrackedSessionMetrics[]
  trackedSessionStatus: TrackedSessionStatus
  // Posters vs participants (rate + lurkers); null when no tracked-session data.
  audienceEngagement: AudienceEngagement | null
  // People's messages per time window; empty when the event had no messages.
  activitySeries: ActivityBucket[]
  // Time windows whose message volume stood out from the rest; empty when none.
  spikes: ChatSpike[]
  // This event plus recent past events in the same topic; just this event if new.
  participationHistory: ParticipationHistoryPoint[]
  // The topic's recent average, or null when this is the topic's only event.
  baseline: SameTopicBaseline | null
  // Counts of people's messages: public chat vs private one-to-one with the bot.
  channelSplit: { public: number; private: number }
  // The configured assistant's name and how many times participants called on it.
  botInvocations: BotInvocations
  // Speaker moments that drew a chat reaction, with how the room responded; empty when none.
  receptions: QuoteReception[]
  // The event's readings and references, counted from participant-visible resources only.
  resourceSummary: ResourceSummary
  // Which platform(s) the event ran on: Nextspace, Zoom, or both.
  eventPlatform: EventPlatform
}

/* The event's readings and references, counted only from what participants could see
   (participant-visible resources). These are exact, first-party counts, like
   participation. required, referenced, and suggested are the resource categories;
   withLinks is how many of those visible resources carry a link. The counts say how many
   readings existed and how many had links, never whether anyone opened them. */
export interface ResourceSummary {
  total: number
  required: number
  referenced: number
  suggested: number
  withLinks: number
}

/* Which platform(s) the event ran on, derived from the conversation's platforms list.
   'both' when it ran on Nextspace and Zoom together. */
export type EventPlatform = 'nextspace' | 'zoom' | 'both'

/* One point on a bar/line/area chart: an x-axis category and its y value. */
export interface VibesChartDataPoint {
  label: string
  value: number
}

/* A named data series (one set of bars/a line/an area). Slack allows 1-6 series
   per chart, each with 1-20 points. */
export interface VibesChartSeries {
  name: string
  data: VibesChartDataPoint[]
}

/* The x-axis for a bar/line/area chart. `categories` fixes the order and must
   line up with each series' point labels. */
export interface VibesChartAxisConfig {
  categories: string[]
  xLabel?: string
  yLabel?: string
}

/* One slice of a pie chart (1-6 per chart). */
export interface VibesChartSegment {
  label: string
  value: number
}

/* A chart that illustrates a standout, rendered with Slack's native
   data_visualization block (no image backend). Bar/line/area carry series plus
   an axis config; pie carries segments. Slack renders it from this data and
   offers no alt-text field, so the standout prose stays the accessible fallback. */
export type CuratedVibesChart =
  | { type: 'bar' | 'line' | 'area'; series: VibesChartSeries[]; axisConfig: VibesChartAxisConfig }
  | { type: 'pie'; segments: VibesChartSegment[] }

export interface CuratedVibesVisual {
  title: string
  chart: CuratedVibesChart
  /* Optional one-line caption rendered as a context block under the chart. The
     data_visualization block has no alt-text field, so this caption is also the
     chart's screen-reader description; keep it a plain-language read of the chart. */
  caption?: string
}

/* One standout: a finished mrkdwn string that names one metric, its direction,
   and (for tracked sessions) its can-undercount caveat inline, so the two data
   sources stay distinct without a separate section. An optional visual renders
   right after it; the design aims for at least one chart per insight. */
export interface CuratedVibesStandout {
  text: string
  visual?: CuratedVibesVisual
}

/* The curated card's render payload (responseKind 'curatedVibesSummary'),
   following the design's block grammar. The curating LLM (Phase 6) writes the
   prose and picks the charts; this phase renders from mock-curated data. The
   footer carries only the event duration. */
export interface CuratedVibesData {
  header: string
  framing?: string
  availabilityNote?: string
  standouts: CuratedVibesStandout[]
  durationMinutes: number
}

export interface ConversationHistorySettings {
  count?: number
  timeWindow?: number // in seconds, going backwards from endTime
  endTime?: Date
  channels?: string[]
  directMessages?: boolean
  excludeOtherAgents?: boolean // When true, only include this agent's own messages (not other agents)
}

export interface ConversationHistory {
  start: Date
  end: Date
  messages: IMessage[]
}

export interface Triggers {
  perMessage?: {
    minNewMessages?: number
    directMessages?: boolean
    channels?: string[]
    conversationHistorySettings?: ConversationHistorySettings
    allowMessagesFromAgents?: boolean
  }
  periodic?: { timerPeriod: number; conversationHistorySettings?: ConversationHistorySettings }
}

export interface GenericAgentAnswer {
  explanation: string
  message: string | Record<string, unknown>
  visible: boolean
  channels: string[]
  action: AgentMessageAction
}

export type LlmPlatforms = 'openai' | 'ollama' | 'perspective' | 'bedrock' | 'vllm' | 'google'

export const LLM_PLATFORMS: LlmPlatforms[] = ['openai', 'ollama', 'perspective', 'bedrock', 'vllm', 'google']

export interface LlmPlatformDetails {
  name: string
  description: string
  options?: ILlmPlatformOptions
}

export interface ILlmPlatformOptions {
  useKeepAlive: boolean
  baseUrl?: string
}

export interface LlmModelDetails {
  name: string
  label: string
  llmPlatform: string
  llmModel: string
  description: string
  defaultModelOptions?: Record<string, unknown>
}

export type EmbeddingsPlatforms = 'openai' | 'infinity'

export const EMBEDDINGS_PLATFORMS: EmbeddingsPlatforms[] = ['openai', 'infinity']

export interface EmbeddingsPlatformDetails {
  name: string
  description: string
  options?: IEmbeddingsPlatformOptions
}

export interface IEmbeddingsPlatformOptions {
  useKeepAlive: boolean
  baseUrl?: string
}

export interface EmbeddingsModelDetails {
  name: string
  label: string
  platform: string
  model: string
  description: string
}

export type ReadScope =
  | { type: 'topic'; id: string; topicIsPrivate?: boolean }
  | { type: 'conversation'; id: string; topicId?: string; topicIsPrivate?: boolean }
export type ReadGrant = ReadScope | { type: 'allPublicTopics' }
export type WriteScope = { type: 'conversation'; id: string }
export type WriteGrant = { type: 'ownConversation' }

export interface AgentCapabilities {
  read: ReadGrant[]
  write: WriteGrant[]
}
export interface ConversationStoppedEvent {
  type: 'conversationStopped'
  conversationId: string
  topicId?: string
}

export type ConversationEvent = ConversationStoppedEvent

export interface IAgent {
  _id?: mongoose.Types.ObjectId
  name: string
  description: string
  pseudonyms: Array<IPseudonym>
  conversation: IConversation
  instanceName?: string
  agentType: string
  llmPlatform: LlmPlatforms
  llmPlatformOptions?: ILlmPlatformOptions
  llmModel: string
  lastActiveMessageCount?: number
  agentEvaluation?: AgentEvaluation
  llmModelOptions?: { [key: string]: unknown }
  llmTemplateVars?: { [key: string]: { name: string; description: string }[] }
  llmTemplates?: { [key: string]: string }
  agentConfig?: { [key: string]: unknown }
  capabilities?: AgentCapabilities
  ragCollectionName?: string
  triggers?: Triggers
  active?: boolean
  conversationHistorySettings?: ConversationHistorySettings
}
