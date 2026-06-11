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
  topic: ITopic
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
  channels: z.array(ChannelZodSchema).optional()
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
