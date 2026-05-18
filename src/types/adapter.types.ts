import type { AdapterChannelConfig } from './index.types.js'

export interface AdapterUser {
  username: string
  pseudonym?: string
  dmConfig?: Record<string, unknown>
}

export interface AdapterMessage<T> {
  message: T
  channels: AdapterChannelConfig[]
  messageType?: string
  user: AdapterUser
  source: { type: string; id?: string }
  createdAt?: Date
  parentMessage?: string
  /** Adapter-specific rich content blocks (e.g. Slack Block Kit). Typed as unknown[] to keep this interface platform-agnostic. */
  blocks?: unknown[]
}
