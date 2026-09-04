import type { AdapterChannelConfig, IUserPreferences } from './index.types.js'

export interface AdapterUser {
  username: string
  pseudonym?: string
  dmConfig?: Record<string, unknown>
  isHost?: boolean
  defaultPreferences?: IUserPreferences
  // The platform's native user ID (e.g. Slack user ID), used to look up an existing account
  // via ConversationMembership.externalIds when the username-based lookup finds nothing.
  externalId?: string
}

export interface AdapterMessage<T> {
  message: T
  channels: AdapterChannelConfig[]
  messageType?: string
  user: AdapterUser
  source: { type: string; id?: string; [key: string]: unknown }
  createdAt?: Date
  parentMessage?: string
  /** Adapter-specific rich content blocks (e.g. Slack Block Kit). Typed as unknown[] to keep this interface platform-agnostic. */
  blocks?: unknown[]
  /** Neutral render instruction. The Slack adapter renders responseKind + renderData into blocks at send time; other adapters ignore them. */
  responseKind?: string
  renderData?: unknown
}
