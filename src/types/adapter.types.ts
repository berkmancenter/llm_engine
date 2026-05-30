import type { AdapterChannelConfig, IUserPreferences } from './index.types.js'

export interface AdapterUser {
  username: string
  pseudonym?: string
  dmConfig?: Record<string, unknown>
  isHost?: boolean
  defaultPreferences?: IUserPreferences
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
}
