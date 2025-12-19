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
}

export interface IBaseUser {
  _id?: mongoose.Types.ObjectId
}

export interface IUser {
  goodReputation?: boolean
  role?: string
  password: string
  email?: string
  username: string
  dataExportOptOut?: boolean
  pseudonyms: mongoose.Types.DocumentArray<IPseudonym>
}

export interface ITopic {
  _id?: mongoose.Types.ObjectId
  id?: string
  slug?: string
  name: string
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

export interface IMessage {
  _id?: mongoose.Types.ObjectId
  owner?: IBaseUser
  body: string | Record<string, unknown>
  bodyType?: string
  source?: string
  channels?: string[]
  conversation: IConversation
  fromAgent: boolean
  pause: boolean
  visible: boolean
  count?: number
  pseudonym: string
  pseudonymId: mongoose.Types.ObjectId
  active?: boolean
  isDeleted?: boolean
  upVotes: Vote[]
  downVotes: Vote[]
  parentMessage?: mongoose.Types.ObjectId
  createdAt?: Date
  updatedAt?: Date
  replyCount?: number
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

export interface ConversationTypeProperty {
  name: string
  required: boolean
  type: 'string' | 'number' | 'boolean' | 'object'
  label?: string
  default?: string | number | boolean | object
  description?: string
  enum?: Array<string | number | boolean | object>
  validationKeys?: string[]
}

export interface ChannelConfig {
  name: string
  passcode?: string | null
  direct?: boolean
}

export interface AgentConfig {
  name: string
  properties?: Record<string, unknown>
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
  properties: ConversationTypeProperty[]
  agents?: AgentConfig[]
  channels?: ChannelConfig[]
  enableDMs?: string[]
  adapters?: Record<string, AdapterConfig>
}

export interface Profile {
  name: string
  bio?: string
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
  startTime?: Date
  endTime?: Date
  adapters: Array<IAdapter>
  enableDMs: string[]
  experimental?: boolean
  experiments: IExperiment[]
  active?: boolean
  locked?: boolean
  enableAgents?: boolean
  owner: IUser
  topic: ITopic
  // TODO make this a first class object later
  transcript: {
    vectorStore: {
      embeddingsPlatform: string
      embeddingsModelName: string
    }
  }
  followed?: boolean
  createdAt?: Date
  updatedAt?: Date
  messageCount?: number
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
  messageType: z.enum(['text', 'json']).optional(),
  channels: z.array(ChannelZodSchema).optional()
})

export interface AgentResponse<T> {
  visible: boolean
  message: T
  channels?: IChannel[]
  messageType?: string
  context?: string
}

export interface ConversationHistorySettings {
  count?: number
  timeWindow?: number // in seconds
  endTime?: Date
  channels?: string[]
  directMessages?: boolean
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
  ragCollectionName?: string
  triggers?: Triggers
  active?: boolean
  conversationHistorySettings?: ConversationHistorySettings
  useTranscriptRAGCollection?: boolean
}
