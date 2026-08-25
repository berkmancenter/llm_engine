import { z } from 'zod'

import mongoose from 'mongoose'

/* The structured fields an Outlook invite's .ics attachment states outright, parsed by the email
   webhook with no LLM involved. uid identifies a recurring series (every instance shares one) and
   pairs with startDate to recognize an invite already handled. */
export interface ParsedInvite {
  uid?: string
  summary?: string
  description?: string
  location?: string
  startDate?: Date
  endDate?: Date
  organizer?: string // organizer email from the .ics ORGANIZER field, mailto: stripped
}

/* The trust boundary in one shape: `invite` is attacker-supplied .ics file content (anyone can put
   any UID or ORGANIZER in a raw .ics), while `fromAddress` is the envelope From that the email
   webhook actually received. Identity resolution keys off fromAddress; ORGANIZER is only ever
   compared against it. body is the email's plain-text body alongside the .ics attachment; the
   .ics fields still win on conflict, body only fills in what they leave out (see
   planner.service.ts's INVITE_SYSTEM_PROMPT). */
export interface InboundInvite {
  fromAddress: string
  invite: ParsedInvite
  body?: string
}

/* A plain inbound email with no .ics attachment (see emailSetup.service.ts's
   createConversationFromEmail). fromName is the sender's display name off the webhook payload
   (Postmark's FromName), used to name the event when there's no subject; messageId is Postmark's
   MessageID, the dedup key for this path since there's no invite UID to use instead. */
export interface InboundEmail {
  fromAddress: string
  fromName?: string
  subject?: string
  body?: string
  messageId?: string
}

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
  /* Marks this entry as a member's real name rather than a pseudonym. A real-name
     entry can never be activated or deleted (see userService.activatePseudonym /
     deletePseudonym) and is exempt from the 5-pseudonym cap. Immutable once set —
     see pseudonymSchema. */
  isRealName?: boolean
  /* Trimmed/whitespace-collapsed/lower-cased copy of `pseudonym`, set only on
     real-name entries, used to scope uniqueness per conversation without letting
     incidental case/whitespace differences create duplicate-looking roster rows. */
  normalizedPseudonym?: string
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
  // Marks a Topic we auto-created instead of the organizer, so we can find it again by owner +
  // source instead of by its (renamable) name. See findOrCreateEmailTopic in topic.service.ts.
  source?: 'email'
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
  /* The scalar metrics a curatedVibesSummary card was built from (one row for a single-event
     recap, several for a trend), quote-free like a stored snapshot. Never rendered to Slack;
     it lets a later thread reply answer a follow-up question from the same numbers rather than
     recomputing or refusing. */
  metricsContext?: unknown
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

export type ExperimentAgent =
  | { agent: IAgent; agentType?: never; experimentValues?: Record<string, unknown> }
  | { agentType: string; agent?: IAgent; experimentValues?: Record<string, unknown> }

export interface IExperiment {
  name: string
  description?: string
  baseConversation: IConversation
  createdBy: IUser
  createdAt: Date
  status: 'running' | 'completed' | 'failed' | 'not started'
  agents?: ExperimentAgent[]
  resultConversation?: IConversation
  executedAt?: Date
}

/* Names a real validator (see conversations/propertyFormats.ts), not a regex, so security rules
   like the Zoom-host check parse the value rather than pattern-match it. Extend the union and add
   the matching validator together. */
export type PropertyFormat = 'zoomUrl'

export interface ConfigProperty {
  name: string
  as?: string // destination key (supports dot notation for nesting); defaults to name
  required: boolean
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'enum'
  label?: string
  default?: string | number | boolean | object
  description?: string
  options?: Array<object>
  validationKeys?: string[]
  itemKey?: string
  schema?: Array<object>
  format?: PropertyFormat // extra validation beyond `type`, run on create and for draft status
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

export interface TriggerCondition {
  scope: 'event' | 'participant'
  condition: string
}

export interface ConversationGoal {
  id: string
  label: string
  description: string
  channel: 'groupChat' | 'dm'
  triggers: {
    conditions: TriggerCondition[]
    participantRequirements?: { minMessageCount?: number }
    minConfidence: number
  }
  guardrails: string[]
  outputContract: {
    format: 'text' | 'poll'
    pollConfig?: PollConfig
    pollInstructions?: string
  }
  examples: string[]
}

export interface ConversationContext {
  conversationType?: string
  purpose?: string
  audience?: {
    expertiseLevel?: 'beginner' | 'mixed' | 'expert'
    assumedBackgroundKnowledge?: 'low' | 'lowToMedium' | 'medium' | 'high'
    type?: string[]
    description?: string
  }
  contentSensitivity?: {
    level?: 'standard' | 'elevated' | 'high'
    domains?: string[]
  }
}

export interface DmPolicy {
  qaBehavior?: {
    responseLength: 'short' | 'medium' | 'long'
    clarifyWhenAmbiguous?: boolean
    addContextWhenUseful?: boolean
    answerScope: 'helpUserUnderstandTheLecture' | 'broaderSubjectArea' | 'companyContextOnly' | 'open'
    allowFollowUpDialogue?: boolean
  }
  proactivePolicy?: {
    initiativeLevel: 'passive' | 'lightlyProactive' | 'moderatelyProactive' | 'highlyProactive'
    minContributionMinutes?: number
    socialSensitivity: 'low' | 'medium' | 'high'
  }
  guardrails?: string[]
}

export interface GroupChatPolicy {
  proactivePolicy?: {
    initiativeLevel: 'passive' | 'lightlyProactive' | 'moderatelyProactive' | 'highlyProactive'
    minContributionMinutes?: number
    socialSensitivity: 'low' | 'medium' | 'high'
  }
  pollPolicy?: {
    allowed?: boolean
  }
  guardrails?: string[]
}

export interface BehaviorPolicy {
  globalPolicy?: {
    tone: 'clearNeutral' | 'warmSupportive' | 'playful' | 'professional'
    verbosity: 'brief' | 'medium' | 'detailed'
    formality: 'casual' | 'semiFormal' | 'formal'
    jargonLevel: 'low' | 'lowToMedium' | 'medium' | 'high'
    safetyPosture: 'standard' | 'strict'
    citationBehavior?: string
    uncertaintyBehavior?: string
    guardrails?: string[]
  }
  channels?: {
    dm?: DmPolicy
    groupChat?: GroupChatPolicy
  }
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
  /* Server-computed: true until all fields required to run this conversation as a scheduled
     event are present and valid (see conversation.service/lifecycle.ts). Read-only from the
     client's perspective: conversation.service recomputes it on every create/update. */
  draft?: boolean
  locked?: boolean
  enableAgents?: boolean
  owner: IUser
  topic: ITopic
  // How this conversation was created, when not the standard event-creation form. Deliberately
  // open-ended (mirrors the model's Mixed type) so a future creation path can store whatever
  // shape it needs; inviteUid is the one shape in use today.
  // The .ics UID of the inbound invite is stored at source.inviteUid; used to detect a webhook
  // retry of the same invite before creating a duplicate (see emailSetup.service.ts).
  source?: {
    [key: string]: unknown
  }
  transcript?: ITranscript
  followed?: boolean
  resources: Resource[]
  createdAt?: Date
  updatedAt?: Date
  messageCount(): number
  summary?: string
  goals?: string[]
  conversationContext?: ConversationContext
  behaviorPolicy?: BehaviorPolicy
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
  /* Sibling of renderData: the scalar metrics a curatedVibesSummary card was built from, quote-
     free like a stored snapshot. Persisted alongside the card so a later thread reply can
     answer a follow-up question from the same numbers. Adapters never render this field. */
  metricsContext?: unknown
  proactive?: boolean
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
  // Allowlisted, source-neutral OCCURRENCE counts of specific in-window page actions (e.g.
  // command:visual, tab:chat). Sibling of deviceBreakdown: counts only, may undercount.
  actionBreakdown: Record<string, number>
  // Allowlisted DISTINCT-VISITOR counts for the same keys: how many different visitors took
  // each action, so the read layer can say "X of N visitors did K", which the occurrence
  // counts alone cannot show.
  actionUserBreakdown: Record<string, number>
  // Distinct visitors with at least one in-window action. The denominator for the
  // per-active-visitor action averages, and at most attendeeCount (a visit can overlap
  // the window without acting in it).
  activeVisitorCount: number
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
  // Raw per-event OCCURRENCE counts of allowlisted page actions (e.g. command:visual, tab:chat).
  actionBreakdown: Record<string, number>
  // The same keys mapped to distinct-visitor counts: how many different people did each action.
  actionUserBreakdown: Record<string, number>
  // Distinct visitors with at least one in-window action; the denominator below.
  activeVisitorCount: number
  // actionBreakdown divided by activeVisitorCount, computed at read time (never stored).
  // Empty when there were no active visitors, so a zero denominator never yields NaN.
  actionBreakdownPerActiveVisitor: Record<string, number>
}

/* The audience-engagement view: how the exact poster count relates to the exact
   participant count (everyone who joined the conversation, from their direct, 1:1
   channel with the agent). Both counts are first-party and exact, so this is always
   present, never an estimate.

   The two counts can still fail to reconcile: a poster who joined through a path that
   never provisioned a direct channel (an older event, a platform not yet wired up) can
   push posterCount past participantCount. In that case we do not invent numbers.
   lurkerCount and participationRate are null and postersExceedTrackedSessions is true,
   so the card can state the two raw counts and explain the gap as a possibility rather
   than show an impossible "0 lurkers, 100% participation". The field name is kept as-is
   to avoid a churny rename now that the source is channels rather than tracked sessions.

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

/* A room-size bucket for peer comparison across different topics, based on posterCount. Fixed
   tiers rather than a window around today's own size, so the prompt can name a band plainly
   ("a typical small event") instead of an unstable relative range. */
export type AttendanceBand = 'tiny' | 'small' | 'medium' | 'large'

/* How today's event compares to recent public peer events of the same size and platform, across
   any topic, unlike SameTopicBaseline, which only looks at this event's own recurring series.
   Peers come only from public topics, the same privacy gate summon and trend use, and are capped
   at the 10 most recent. Null below 3 qualifying peers, where a thin cohort would read as more
   authoritative than it is. */
export interface PeerBaseline {
  band: AttendanceBand
  eventCount: number
  avgPosterCount: number
  // The next two average only over peers that had the figure, so each carries its own count and
  // a reader never assumes the average spans every peer.
  avgParticipationRate: number | null
  participationRateEventCount: number
  avgTopPosterMessageShare: number | null
  concentrationEventCount: number
}

/* A metric that has a comparison average to measure against. Named after the field it reads:
   posterCount and lurkerCount read from participation/audienceEngagement, participationRate and
   topPosterMessageShare from their own metrics, avgDwellSeconds from the primary tracked source. */
export type DeviationMetric =
  | 'posterCount'
  | 'participationRate'
  | 'topPosterMessageShare'
  | 'lurkerCount'
  | 'avgDwellSeconds'

/* Which average a deviation is measured against: this topic's own recent history, or public
   peer events of about the same size and platform, across any topic. */
export type DeviationComparison = 'topicBaseline' | 'peerBaseline'

/* One metric's difference from a comparison average, already computed so the curator does not
   have to eyeball the raw numbers to find what stands out. tier carries the same two-tier trust
   split as the rest of the data: 'exact' for first-party counts (posterCount, participationRate,
   topPosterMessageShare, lurkerCount), 'estimate' for a tracked-session figure (avgDwellSeconds),
   which still needs the usual possible-undercount caveat. percentDifference is signed: positive
   means value ran above comparedTo, negative means below; direction restates that sign in words
   so a reader never has to work out which way a negative number points. */
export interface DeviationSignal {
  metric: DeviationMetric
  comparison: DeviationComparison
  tier: 'exact' | 'estimate'
  value: number
  comparedTo: number
  percentDifference: number
  direction: 'above' | 'below'
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

/* Which slice of one event's human messages an on-demand computation covers. The computations
   are fixed and server-side, so this filter is the whole vocabulary a question can be asked in.
   An omitted field narrows nothing, so an empty filter reads the whole event. */
export interface MessageMetricFilter {
  // Elapsed minutes from the event start, from inclusive and to exclusive, as activity buckets use.
  fromMinute?: number
  toMinute?: number
  // 'public' is the group chat, 'private' is a one-to-one with the bot.
  channel?: 'public' | 'private' | 'all'
  // Drops shorter messages, so a question about substantial replies can exclude one-word ones.
  minWordCount?: number
}

/* How much was said in one slice of an event, and by how many different people. */
export interface MessageActivityCount {
  messageCount: number
  // Each person counted once, grouped the same way participation is.
  posterCount: number
  // How many of those people sent at least the requested number of messages, null when none asked.
  postersAtOrAboveThreshold: number | null
}

/* How long the messages in one slice were, in words. Word counts only: no message text leaves
   this computation. */
export interface MessageLengthStats {
  messageCount: number
  // Null on an empty slice, so it never reads as zero-word messages.
  medianWordCount: number | null
  longestWordCount: number | null
}

/* One computation the analyst ran over an event's own messages to answer a question its
   precomputed metrics could not. Recorded so the fact-checking pass can trace a cited number back
   to the computation behind it. Tool results are server-computed, so they stay first-party and
   keep the same trust tier as the rest of the participation data. */
export interface OnDemandComputation {
  tool: string
  args: MessageMetricFilter & { minMessages?: number }
  result: MessageActivityCount | MessageLengthStats
}

/* The bundle of numbers the recap card and the curating LLM both read for one
   event. Participation (from our own database) is always present and exact. Tracked
   sessions are a separate layer (one entry per analytics source that has stored
   data) and are never merged into a single combined score. */
export interface ConversationMetrics {
  participation: ParticipationMetrics
  // One entry per analytics source that has stored data; empty when none.
  trackedSessionSources: TrackedSessionMetrics[]
  trackedSessionStatus: TrackedSessionStatus
  // Posters vs participants (rate + lurkers); always present, since the channel-based
  // participant count is exact.
  audienceEngagement: AudienceEngagement
  // People's messages per time window; empty when the event had no messages.
  activitySeries: ActivityBucket[]
  // Time windows whose message volume stood out from the rest; empty when none.
  spikes: ChatSpike[]
  // This event plus recent past events in the same topic; just this event if new.
  participationHistory: ParticipationHistoryPoint[]
  // The topic's recent average, or null when this is the topic's only event.
  baseline: SameTopicBaseline | null
  // How today compares to recent public peer events of the same size and platform, across any
  // topic; null when too few peers qualify.
  peerBaseline: PeerBaseline | null
  // Metrics furthest from a comparison average, largest difference first; empty when nothing
  // was available to compare against.
  topDeviations: DeviationSignal[]
  // Counts of people's messages: public chat vs private one-to-one with the bot.
  channelSplit: { public: number; private: number }
  // Private (one-to-one with the bot) messaging: counts plus distinct senders, with the
  // per-poster average derived at read time.
  privateMessaging: PrivateMessaging
  // How long after the event started the first human message landed, per surface.
  timeToFirstMessage: TimeToFirstMessage
  // How quickly people replied to each other, over threaded human replies.
  replyLatency: ReplyLatency
  // How concentrated the chat was in a few posters, plus one-time vs repeat posters.
  participationConcentration: ParticipationConcentration
  // The shape of threaded conversation: thread count, sizes, and deepest reply chain.
  interactionStructure: InteractionStructure
  // The configured assistant's name and how many times participants called on it.
  botInvocations: BotInvocations
  // Speaker moments that drew a chat reaction, with how the room responded; empty when none.
  receptions: QuoteReception[]
  // The event's readings and references, counted from participant-visible resources only.
  resourceSummary: ResourceSummary
  // Which platform(s) the event ran on: Nextspace, Zoom, or both.
  eventPlatform: EventPlatform
  // Computations run over this event's messages to answer one specific question, present only
  // on that path and scoped to that one request. The analytics service never sets it and no
  // snapshot ever stores it; it rides along so the fact-checking pass can verify a cited
  // on-demand number the same way it verifies every other number here.
  onDemandComputations?: OnDemandComputation[]
}

/* Private (one-to-one with the bot) messaging, all exact and first-party, grouped per person the
   same way participation is. */
export interface PrivateMessaging {
  // The same count as channelSplit.private.
  privateMessageCount: number
  // Someone who used both channels lands in both, so these overlap: not additive, and their sum
  // can exceed posterCount.
  distinctPrivateSenders: number
  distinctPublicSenders: number
  // Over all distinct posters, derived at read time and 0 when nobody posted.
  avgPrivateMessagesPerPoster: number
}

/* Seconds from the event start to the first human message on each surface, both first-party.
   public is the open group chat (the default for any non-direct channel, including the
   no-channel main feed); private is a one-to-one with the bot. Each is null when that surface
   had no timestamped human message, and both are null when the event start is unknown, since
   "time to first" has no meaning without a start. The bot's own messages (including its intro)
   never count: the metric reads the same human-only message set as every other participation
   count. A message stamped before the recorded start reports 0, not negative time. */
export interface TimeToFirstMessage {
  publicSeconds: number | null
  privateSeconds: number | null
}

/* Reply speed over threaded human replies (a message answering another via parentMessage).
   medianSecondsToFirstReply is the median, across every human message that drew a reply, of the
   seconds to its first reply; null when no human replied to another (including events with no
   threading). repliedMessageCount is how many messages drew at least one reply, so the read layer
   knows how much of the conversation was threaded before trusting the median. Both first-party,
   from message timestamps and parent links. */
export interface ReplyLatency {
  medianSecondsToFirstReply: number | null
  repliedMessageCount: number
}

/* Participation concentration: how much of the chat came from a small core, and how many people
   posted just once. All exact and first-party, grouped per person the same way participation is. */
export interface ParticipationConcentration {
  // The busiest three by message volume, or the poster count when the room is smaller.
  topPosterCount: number
  // Those posters' share of all messages (0 to 1). A fixed-count companion to
  // participation.frequentPosterMessageShare, which scales with room size instead (top 10%).
  // Null below a handful of posters, where a top-few share covers the room and says nothing.
  topPosterMessageShare: number | null
  // Splits drive-by single posts from sustained back-and-forth. Always sums to the poster count.
  oneTimePosterCount: number
  repeatPosterCount: number
}

/* The shape of threaded conversation, from the parentMessage links among human messages. A thread
   is a root message (no parent, or a parent outside the human set such as the bot) plus everything
   descending from it, and it counts only once it drew a reply, so a lone unanswered post is not a
   thread. Together these say whether the room held a few long back-and-forths or many shallow
   ones. All exact and first-party. */
export interface InteractionStructure {
  threadCount: number
  // Message count of the largest thread, root included.
  maxThreadSize: number
  medianThreadSize: number | null
  // Deepest reply chain, in edges from the root, so a direct reply is 1. Zero when nothing threaded.
  maxReplyDepth: number
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

/* One persisted snapshot of a conversation's metrics, one document per conversation in its
   own collection. It is written when a conversation ends and its recap is built, so every
   metric can be trended over time instead of recomputed from raw messages on each recap. The
   shape mirrors ConversationMetrics but keeps only scalar aggregates: the verbatim quote text
   that spikes and receptions carry (spike.annotation, reception.sparkQuote/reactionQuote) is
   deliberately dropped, because this is a long-lived analytics store and those quotes are
   word-for-word chat and backchannel content. Counts are kept; the words are not.

   metricsVersion stamps the metric definitions in force when the snapshot was taken, so a
   trend that crosses a definition change is never read as a continuous line (see
   METRICS_VERSION in conversationAnalytics.service). The estimate block, everything sourced
   from web analytics, is captured "as of" capturedAt and is never chased when late provider
   data lands after the conversation ends.

   The tracked-session fields are nullable because a conversation may have had no web-analytics
   data at all. receptionCount is nullable for a separate reason: it is filled by an LLM pass
   when the live card is built, so a recompute that skips that step (the backfill) records null
   ("not computed") rather than a misleading 0. */
export interface ConversationMetricsSnapshotData {
  conversationId: mongoose.Types.ObjectId
  topicId: mongoose.Types.ObjectId
  name?: string
  endTime: Date
  platform: EventPlatform
  metricsVersion: number
  capturedAt: Date
  // Participation (exact, from our own database).
  posterCount: number
  messageCount: number
  frequentPosterCount: number
  frequentPosterMessageShare: number | null
  // Audience engagement (exact, as of capturedAt): the direct-channel participant count.
  // lurkerCount/participationRate are null when the poster count could not be reconciled
  // against it (postersExceedTrackedSessions is true in that case).
  trackedSessionStatus: TrackedSessionStatus
  trackedSessions: number | null
  participantCount: number
  lurkerCount: number | null
  participationRate: number | null
  postersExceedTrackedSessions: boolean
  avgDwellSeconds: number | null
  totalActions: number | null
  // Feature usage (estimate, as of capturedAt): allowlisted page actions off the primary
  // tracked source. Occurrence counts, distinct-visitor counts, and the active-visitor
  // denominator. Empty maps when no tracked source carried action data, where activeVisitorCount
  // is null like the other estimate fields.
  actionBreakdown: Record<string, number>
  actionUserBreakdown: Record<string, number>
  activeVisitorCount: number | null
  // Channel split (exact): people's messages, public chat vs private one-to-one with the bot.
  channelSplit: { public: number; private: number }
  // Private messaging (exact): the private message count and distinct senders per channel
  // kind, so the share-of-posters comparison can be trended.
  privateMessageCount: number
  distinctPrivateSenders: number
  distinctPublicSenders: number
  // Bot invocations (exact): how many times participants called on the assistant by name.
  botInvocationCount: number
  // Resource counts (exact), from participant-visible resources only.
  resourceSummary: ResourceSummary
  // How many time windows stood out as spikes; the quote/topic annotation is not stored.
  spikeCount: number
  // How many speaker moments drew a chat reaction; quotes are not stored. Null when the
  // reception pass did not run (e.g. a backfill that recomputes scalars only).
  receptionCount: number | null
  // The four pacing/shape metrics (exact, first-party), stored as computed so peer-cohort
  // comparison (see computePeerBaseline) and future trends can read them, the same shape as
  // their ConversationMetrics counterparts.
  timeToFirstMessage: TimeToFirstMessage
  replyLatency: ReplyLatency
  participationConcentration: ParticipationConcentration
  interactionStructure: InteractionStructure
}

/* The snapshot fields the trend chart and label read by name, off a stored snapshot or a live
   recompute. A projection of ConversationMetricsSnapshotData so the two stay in lockstep:
   trendRow reads every other metric generically, so a snapshot carrying more reaches the writer
   without a change here, and quote text is never stored, so a trend is quote-free by
   construction. */
export type TrendSnapshotView = Pick<
  ConversationMetricsSnapshotData,
  | 'name'
  | 'endTime'
  | 'posterCount'
  | 'messageCount'
  | 'lurkerCount'
  | 'participationRate'
  | 'avgDwellSeconds'
  | 'spikeCount'
  | 'channelSplit'
>

/* One point on a bar/line/area chart: an x-axis category and its y value. */
export interface VibesChartDataPoint {
  label: string
  value: number
}

/* A named data series (one set of bars/a line/an area). Slack allows 1-12 series
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
   prose and picks the charts; this phase renders from mock-curated data. A
   single-event card ends with a duration footer; a trend card leaves
   durationMinutes unset, since one duration cannot describe many events. */
export interface CuratedVibesData {
  header: string
  framing?: string
  availabilityNote?: string
  standouts: CuratedVibesStandout[]
  durationMinutes?: number
}

export interface BudgetAlert {
  label: string
  used: number
  limit: number
  percentUsed: number
}

export interface BudgetAlertData {
  alerts: BudgetAlert[]
  checkedAt: string
}

export interface QualityReportEvaluatorScore {
  key: string
  mean: number
  min: number
  count: number
  lowScoreCount: number
}

export interface QualityReportLowScoreTrace {
  runId: string
  url: string | null
  lowScores: Array<{ key: string; score: number }>
}

export interface QualityReportData {
  conversationName: string
  conversationId: string
  evaluators: QualityReportEvaluatorScore[]
  overallMean: number
  tracesScored: number
  lowScoreTraces: QualityReportLowScoreTrace[]
  totalLowScoreCount: number
  generatedAt: string
  /** Per-evaluator delta vs. 30-day cross-conversation baseline. Omitted when baseline has < 5 samples. */
  deltas?: Record<string, number>
  /** Number of reports used to compute the baseline. */
  baselineSampleCount?: number
}

/* Per-model aggregation of a conversation's llm-type LangSmith runs. Costs come from
   LangSmith's own pricing table, not the provider invoice, so every figure is an
   estimate — user-facing copy must say so.

   `priced` is false if LangSmith's pricing table had no entry for at least one call
   to this model (verified 2026-07-14: self-hosted vLLM/Ollama models return real
   token counts but a null total_cost, since there is no published per-token price
   to look up). Without this flag, a null cost is indistinguishable from a genuinely
   free call — see conversationCost.ts's fetchConversationCost for where this is
   detected and a note on a possible future custom-pricing adapter for those
   platforms. */
export interface ModelCostBreakdown {
  model: string
  llmCalls: number
  promptTokens: number
  completionTokens: number
  estimatedCostUSD: number
  priced: boolean
}

/* Per-agent aggregation: llm runs grouped by the agentType that names their trace root
   (both traceable wrappers in the agent model name roots after the agentType). */
export interface AgentCostBreakdown {
  agentType: string
  llmCalls: number
  estimatedCostUSD: number
}

/* One phase's cost aggregate. A "phase" separates spend that happens while a
   conversation is still live (agent respond() calls, tagged costPhase 'liveEvent')
   from spend that happens after it stops (the Vibes Analyst recap, the conversation
   summary — tagged 'postEvent'), so the two can be reported and queried separately
   instead of only as one combined total. */
export interface ConversationCostAggregates {
  estimatedCostUSD: number
  totalPromptTokens: number
  totalCompletionTokens: number
  llmCallCount: number
  models: ModelCostBreakdown[]
  agents: AgentCostBreakdown[]
  // True if any llm call in this phase could not be priced (see ModelCostBreakdown.priced) —
  // estimatedCostUSD is a floor, not the true total, when this is true.
  hasUnpricedCalls: boolean
}

/* What the LangSmith fetch returns: the two phases, kept separate rather than
   pre-summed, so callers that only care about one phase never have to undo a sum. */
export interface ConversationCostPhases {
  liveEvent: ConversationCostAggregates
  postEvent: ConversationCostAggregates
}

/* Render payload for the 'conversationCostSummary' card. `total` is the two phases
   combined, computed once by the caller so the renderer never has to know how to
   combine aggregates itself. */
export interface ConversationCostData extends ConversationCostPhases {
  conversationName: string
  checkedAt: string
  total: ConversationCostAggregates
  topicIsPrivate: boolean
}

/* The persisted shape: the two phase aggregates plus which conversation they price
   and where the figures came from. `source` exists so a second cost source (e.g.
   provider billing exports) could coexist later without a schema change. */
export interface ConversationCostRecord extends ConversationCostPhases {
  _id?: mongoose.Types.ObjectId
  conversationId: mongoose.Types.ObjectId
  name?: string
  source: 'langsmith'
  capturedAt?: Date
  // 'pending' from the moment the event stops until the settle-poll resolves (see
  // conversationCost.service.ts's createPending/persistCost); never left pending
  // forever — persistCost always flips it to 'complete', even with zero cost data.
  status: 'pending' | 'complete'
  // Carried through so private-event cost can be reported on separately later.
  // postEvent is always empty for a private event: no post-event agent (e.g. the
  // Vibes Analyst recap) ever runs on a private topic, so there is nothing to price.
  topicIsPrivate: boolean
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
  periodic?: { timerPeriod: number; proactive?: boolean; conversationHistorySettings?: ConversationHistorySettings }
  cron?: { expression: string }
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
export type ReadGrant = ReadScope | { type: 'allPublicTopics' } | { type: 'allTopics' }
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
