import type { ChatPostMessageResponse } from '@slack/web-api'
import Adapter from '../models/adapter.model.js'
import slackClientPool from '../adapters/slack/client.js'
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

const NOTIFY_TIMEOUT_MS = 10000

export function isArchiveNotifyConfigured(config: ArchiveNotifyConfig) {
  return !!config.notifySlackAdapterId && !!config.notifySlackChannel
}

/** `inbox/conversations/event-<hash>.md` -> `event-<hash>` */
export function archiveDraftId(path: string) {
  return path.replace(/^.*\//, '').replace(/\.md$/, '')
}

/** Short log-safe reason: never a token, response body or draft content. */
function slackFailureReason(error: unknown) {
  const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error
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
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const post = slackClientPool.getClient(botToken).chat.postMessage({
      channel: config.notifySlackChannel!,
      text: archiveDraftCardText(data),
      blocks: renderArchiveDraftCard(data)
    })
    // The Slack client retries internally; bound the wait so a slow Slack never holds the job.
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), NOTIFY_TIMEOUT_MS)
      timer.unref?.()
    })
    const result = await Promise.race([post, timeout])
    if (result === 'timeout') {
      post.catch(() => undefined)
      return { sent: false, reason: 'timeout' }
    }
    const response = result as ChatPostMessageResponse
    if (!response.ok) return { sent: false, reason: slackFailureReason({ data: response }) }
    return { sent: true }
  } catch (error) {
    return { sent: false, reason: slackFailureReason(error) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
