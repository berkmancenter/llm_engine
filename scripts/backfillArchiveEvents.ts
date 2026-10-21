/* eslint-disable no-console */
/** Bounded archive backfill. Dry-run unless --enqueue; never calls chat adapters. */
import mongoose from 'mongoose'
import config from '../src/config/config.js'
import Conversation from '../src/models/conversation.model.js'
import agenda from '../src/jobs/index.js'
import schedule from '../src/jobs/schedule.js'
import { archiveEventEligibility, type ArchiveEvent } from '../src/services/archiveEvent.service.js'

const args = process.argv.slice(2)
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
    if (!reason && args.includes('--enqueue')) {
      if (args.includes('--retry')) await schedule.retryArchiveEvent(eventId)
      await schedule.archiveEvent(eventId)
    }
    let outcome = args.includes('--enqueue') ? 'queued' : 'eligible (dry-run)'
    if (reason) outcome = `skipped=${reason}`
    console.log(`event=${eventId} ${outcome}`)
  }
} finally {
  await agenda.close({ force: true })
  await mongoose.disconnect()
}
