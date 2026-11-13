/* eslint-disable no-console */
/** Bounded archive backfill. Dry-run unless --enqueue; never calls chat adapters. */
import mongoose from 'mongoose'
import { pathToFileURL } from 'node:url'
import config from '../src/config/config.js'
import Conversation from '../src/models/conversation.model.js'
import agenda from '../src/jobs/index.js'
import schedule from '../src/jobs/schedule.js'
import { archiveEventEligibility, type ArchiveEvent } from '../src/services/archiveEvent.service.js'

export default async function backfillArchiveEvents(args: string[]) {
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '25')
  const id = args.find((a) => a.startsWith('--id='))?.split('=')[1]
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000')
  if (id && !mongoose.isValidObjectId(id)) throw new Error('Invalid event id')
  if (args.includes('--enqueue') && !config.bkcArchive.exportEnabled) throw new Error('Archive export is disabled')
  try {
    await mongoose.connect(config.mongoose.url, config.mongoose.options)
    const events = await Conversation.find({
      ...(id ? { _id: id } : {}),
      active: false,
      draft: false,
      endTime: { $ne: null },
      summary: { $exists: true, $ne: '' },
      conversationType: { $in: ['eventAssistant', 'backChannel'] }
    })
      .select('name conversationType active draft locked enforceMembership startTime endTime summary presenters topic')
      .populate({ path: 'topic', select: 'private isDeleted' })
      .sort({ endTime: -1, _id: 1 })
      .limit(limit)
      .lean()
    for (const event of events) {
      const reason = archiveEventEligibility(event as ArchiveEvent)
      const eventId = event._id.toString()
      let outcome = 'eligible (dry-run)'
      if (reason) outcome = `skipped=${reason}`
      else {
        const jobs = await agenda.jobs({ name: 'archiveEvent', 'data.conversationId': eventId })
        const delivered = jobs.some((job) => job.attrs.data.status === 'delivered')
        if (delivered) outcome = 'already_delivered'
        else if (jobs.length) {
          const terminal = jobs.every((job) => ['failed', 'skipped'].includes(job.attrs.data.status))
          outcome = 'already_queued'
          if (terminal && args.includes('--retry')) {
            outcome = 'retryable (dry-run)'
            if (args.includes('--enqueue')) {
              await schedule.retryArchiveEvent(eventId)
              outcome = 'requeued'
            }
          }
        } else if (args.includes('--enqueue')) {
          await schedule.archiveEvent(eventId)
          outcome = 'queued'
        }
      }
      console.log(`event=${eventId} ${outcome}`)
    }
  } finally {
    await agenda.close({ force: true })
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await backfillArchiveEvents(process.argv.slice(2))
}
