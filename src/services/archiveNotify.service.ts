import { WebClient, type WebClientOptions } from '@slack/web-api'
import Adapter from '../models/adapter.model.js'
import renderArchiveDraftCard, {
  archiveDraftCardText,
  type ArchiveDraftCardData
} from '../adapters/slack/blocks/archive/archiveDraftCard.js'

/** Curator notice for a newly created archive draft, posted with an existing Slack adapter's bot. */
export interface ArchiveNotifyConfig {
  notifySlackAdapterId?: string
  notifySlackChannel?: string
}

export interface ArchiveDraftNotice {
  title: string
  date: string
  path: string
}

export type ArchiveNotifyResult = { sent: true } | { sent: false; reason: string }

export const NOTIFY_TIMEOUT_MS = 10000

/**
 * A one-shot client for the notice, not the shared pooled client: the pooled
 * default retries for ~30 minutes and waits out rate limits, which could post
 * long after the job logged a failure. This one fails fast and never posts late.
 */
export const notifyClientOptions: WebClientOptions = {
  retryConfig: { retries: 0 },
  timeout: NOTIFY_TIMEOUT_MS,
  rejectRateLimitedCalls: true
}

export function createNotifyClient(botToken: string) {
  return new WebClient(botToken, notifyClientOptions)
}

export function isArchiveNotifyConfigured(config: ArchiveNotifyConfig) {
  return !!config.notifySlackAdapterId && !!config.notifySlackChannel
}

/** `inbox/conversations/event-<hash>.md` -> `event-<hash>` */
export function archiveDraftId(path: string) {
  return path.replace(/^.*\//, '').replace(/\.md$/, '')
}

/** Short log-safe reason: never a token, response body or draft content. */
function slackFailureReason(error: unknown) {
  const err = error as { code?: unknown; original?: { code?: unknown }; data?: { error?: unknown } } | undefined
  if (err?.code === 'slack_webapi_rate_limited_error') return 'slack_rate_limited'
  if (err?.code === 'slack_webapi_request_error' && ['ECONNABORTED', 'ETIMEDOUT'].includes(err.original?.code as string)) {
    return 'timeout'
  }
  const code = err?.data?.error
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? `slack_${code}` : 'slack_request_failed'
}

/**
 * Posts a short card for a new draft. Never throws; a failure comes back as a
 * short reason so the caller can log it without affecting delivery.
 */
export async function notifyArchiveDraftCreated(
  config: ArchiveNotifyConfig,
  notice: ArchiveDraftNotice
): Promise<ArchiveNotifyResult> {
  if (!isArchiveNotifyConfigured(config)) return { sent: false, reason: 'not_configured' }
  let adapter: { type?: string; config?: { botToken?: unknown } } | null
  try {
    adapter = (await Adapter.findById(config.notifySlackAdapterId).select('type config.botToken').lean()) as typeof adapter
  } catch {
    return { sent: false, reason: 'adapter_lookup_failed' }
  }
  if (!adapter) return { sent: false, reason: 'adapter_not_found' }
  if (adapter.type !== 'slack') return { sent: false, reason: 'adapter_not_slack' }
  const botToken = adapter.config?.botToken
  if (typeof botToken !== 'string' || !botToken) return { sent: false, reason: 'missing_bot_token' }

  const data: ArchiveDraftCardData = { title: notice.title, date: notice.date, draftId: archiveDraftId(notice.path) }
  try {
    const response = await createNotifyClient(botToken).chat.postMessage({
      channel: config.notifySlackChannel!,
      text: archiveDraftCardText(data),
      blocks: renderArchiveDraftCard(data)
    })
    if (!response.ok) return { sent: false, reason: slackFailureReason({ data: response }) }
    return { sent: true }
  } catch (error) {
    return { sent: false, reason: slackFailureReason(error) }
  }
}
