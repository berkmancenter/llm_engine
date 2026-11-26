import type { Job } from 'agenda'
import Conversation from '../../models/conversation.model.js'
import '../../models/topic.model.js' // registers Topic, which the query below populates
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import {
  ArchiveDeliveryError,
  archiveEventEligibility,
  archiveEventPayload,
  deliverArchiveEvent,
  type ArchiveEvent
} from '../../services/archiveEvent.service.js'
import { isArchiveNotifyConfigured, notifyArchiveDraftCreated } from '../../services/archiveNotify.service.js'

export interface ArchiveEventJobData {
  conversationId: string
  attempts?: number
  status?: 'queued' | 'delivering' | 'retry' | 'delivered' | 'skipped' | 'failed'
  reason?: string
  path?: string
}

const MAX_ATTEMPTS = 6

/**
 * Best-effort curator notice. Never throws: the job is already saved as delivered,
 * so a Slack failure is logged and must not trigger a retry or change the status.
 * A crash between the delivered save and this call skips the notice (the job is
 * delivered, and a redelivery would return 200), which we accept over pinging twice.
 */
async function notifyCurators(id: string, event: ArchiveEvent, path: string) {
  try {
    const { title, date } = archiveEventPayload(event)
    const result = await notifyArchiveDraftCreated(config.bkcArchive, { title, date, path })
    if (result.sent) logger.info(`Archive export notified event=${id}`)
    else logger.warn(`Archive export notify failed event=${id} reason=${result.reason}`)
  } catch {
    logger.warn(`Archive export notify failed event=${id} reason=internal_error`)
  }
}

export async function archiveEvent(job: Job<ArchiveEventJobData>) {
  const { data } = job.attrs
  const id = data.conversationId
  if (data.status === 'delivered' || data.status === 'skipped' || data.status === 'failed') return
  try {
    if (!config.bkcArchive.exportEnabled) {
      data.status = 'skipped'
      data.reason = 'export_disabled'
      await job.save()
      logger.info(`Archive export skipped event=${id} reason=${data.reason}`)
      return
    }
    const event = (await Conversation.findById(id)
      .select(
        'name conversationType active draft locked enforceMembership startTime endTime postEventAnalysis.summary presenters topic'
      )
      .populate({ path: 'topic', select: 'private isDeleted' })
      .lean()) as ArchiveEvent | null
    const reason = archiveEventEligibility(event)
    if (reason) {
      data.status = 'skipped'
      data.reason = reason
      await job.save()
      logger.info(`Archive export skipped event=${id} reason=${reason}`)
      return
    }
    if ((data.attempts || 0) >= MAX_ATTEMPTS) {
      data.status = 'failed'
      data.reason = 'attempt_limit'
      await job.save()
      logger.error(`Archive export failed event=${id} reason=attempt_limit`)
      return
    }
    data.attempts = (data.attempts || 0) + 1
    data.status = 'delivering'
    await job.save()
    // Persist the attempt before the side effect. A crash may still repeat the
    // request, so the API claims the stable source/event ID atomically, before
    // returning. Re-delivery must acknowledge the original draft, never create one.
    const delivery = await deliverArchiveEvent(config.bkcArchive.apiUrl, config.bkcArchive.apiToken, event!)
    data.path = delivery.path
    data.status = 'delivered'
    delete data.reason
    await job.save()
    logger.info(`Archive export delivered event=${id} path=${data.path}`)
    // Only a newly created draft (HTTP 201) pings curators; duplicates stay quiet.
    if (delivery.created && isArchiveNotifyConfigured(config.bkcArchive)) {
      await notifyCurators(id, event!, delivery.path)
    }
  } catch (error) {
    data.reason = error instanceof ArchiveDeliveryError ? error.message : 'internal_error'
    const retryable = !(error instanceof ArchiveDeliveryError) || error.retryable
    // Database read/save failures also consume the bounded retry allowance.
    if (data.status !== 'delivering') data.attempts = (data.attempts || 0) + 1
    if (retryable && (data.attempts || 0) < MAX_ATTEMPTS) {
      data.status = 'retry'
      job.schedule(new Date(Date.now() + Math.min(60 * 60 * 1000, 60000 * 2 ** ((data.attempts || 1) - 1))))
      await job.save()
      logger.warn(`Archive export retry event=${id} attempt=${data.attempts} reason=${data.reason}`)
    } else {
      data.status = 'failed'
      await job.save()
      logger.error(`Archive export failed event=${id} attempts=${data.attempts} reason=${data.reason}`)
    }
  }
}

export default { archiveEvent }
