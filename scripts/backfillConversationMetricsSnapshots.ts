#!/usr/bin/env node
/**
 * Backfills a per-conversation metrics snapshot for past events, so the Vibes Analyst baseline
 * and history have something to read the moment this feature ships. Without it, every topic's
 * trend would be empty until new events end and accrue their own snapshots.
 *
 * It recomputes each event's scalar metrics with the live service and persists them. It does
 * NOT run the analyst's LLM passes (spike and reception annotation), so the reception count is
 * recorded as null ("not computed") rather than a misleading 0, and no spike or reception
 * quote text is involved at all.
 *
 * Two kinds of event are skipped:
 *   - Experimental events (test runs), the same exclusion the live write makes.
 *   - Events that never had web analytics wired up (no stored ConversationAnalytics summary).
 *     Their estimate metrics (lurkers, participation rate, dwell) would be missing, so a
 *     snapshot would trend a partial picture. Exact metrics alone are not enough to seed on.
 *
 * It runs in age-based batches so a long history can be seeded a window at a time, checking the
 * result between each: --min-age-days and --max-age-days bound how long ago an event ended.
 * Batch one is the most recent 30 days (0 to 30), batch two is 30 to 60, and so on. With no
 * window it processes every past event. After each batch it prints, per event, the metrics it
 * wrote, with the prior values alongside (null on a first run, the old values on an overwrite),
 * so the effect of the batch is visible.
 *
 * By default an event that already has a snapshot for the current metrics version is left
 * untouched, so the script is safe to re-run. Pass --overwrite to recompute and replace them.
 *
 * Flags:
 *   --dry-run            Compute and report what would be written, but persist nothing.
 *   --overwrite          Recompute and replace snapshots that already exist for this version.
 *   --min-age-days=N     Only events that ended at least N days ago (default 0).
 *   --max-age-days=N     Only events that ended within N days (default: no older bound).
 *
 * RUNNING IT IN PRODUCTION (seed newest-first in 30-day batches, previewing each one):
 *
 *   cd into the repo, then for each batch preview, commit, and move the window back:
 *
 *   # Batch 1: preview the most recent 30 days, write nothing
 *   NODE_ENV=production node --loader ts-node/esm scripts/backfillConversationMetricsSnapshots.ts \
 *     --min-age-days=0 --max-age-days=30 --dry-run
 *
 *   # Batch 1: commit it
 *   NODE_ENV=production node --loader ts-node/esm scripts/backfillConversationMetricsSnapshots.ts \
 *     --min-age-days=0 --max-age-days=30
 *
 *   # Batch 2: 30-60 days old, and so on (30-60, 60-90, ...)
 *   NODE_ENV=production node --loader ts-node/esm scripts/backfillConversationMetricsSnapshots.ts \
 *     --min-age-days=30 --max-age-days=60
 *
 *   Each batch prints a summary line plus, per event, posters / messages / lurkers / dwell /
 *   spikes / receptions, showing before->after when a value changed (before is null on a first
 *   run). Omit the window flags entirely to process all past events in one pass.
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import config from '../src/config/config.js'
import Conversation from '../src/models/conversation.model.js'
import ConversationAnalytics from '../src/models/conversationAnalytics.model.js'
import ConversationMetricsSnapshot from '../src/models/conversationMetricsSnapshot.model.js'
import conversationAnalyticsService, { METRICS_VERSION } from '../src/services/conversationAnalytics.service.js'
import conversationMetricsSnapshotService from '../src/services/conversationMetricsSnapshot.service.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/* The readable slice of a snapshot the backfill reports per event, so a run can be eyeballed
   without dumping every field. These are the metrics most worth sanity-checking as a trend. */
export interface SnapshotMetricsView {
  posterCount: number
  messageCount: number
  lurkerCount: number | null
  participationRate: number | null
  avgDwellSeconds: number | null
  channelSplit: { public: number; private: number }
  botInvocationCount: number
  spikeCount: number
  receptionCount: number | null
}

/* One event the backfill acted on: its identity plus the snapshot metrics before and after the
   write. before is null when no snapshot existed for this metrics version (a first run). */
export interface BackfilledEvent {
  conversationId: string
  name?: string
  endTime?: Date
  before: SnapshotMetricsView | null
  after: SnapshotMetricsView
}

export interface BackfillSummary {
  window: { minAgeDays: number; maxAgeDays: number | null }
  scanned: number
  backfilled: number
  skippedExisting: number
  skippedNoTrackedData: number
  events: BackfilledEvent[]
}

interface BackfillOptions {
  dryRun?: boolean
  /* Only events whose end is at least this many days before `now` (default 0, i.e. now). */
  minAgeDays?: number
  /* Only events whose end is within this many days of `now`. Omit for no older bound. */
  maxAgeDays?: number
  /* Recompute and replace snapshots that already exist for this metrics version. */
  overwrite?: boolean
  /* The reference point ages are measured from. Defaults to the current time; injectable so
     the window is deterministic in tests. */
  now?: Date
}

/* Pulls the reported slice out of either a persisted snapshot document or a freshly built
   payload. A stored document types its nested and nullable fields loosely (optional, possibly
   undefined), so the fields are read tolerantly and coerced to the view's shape. */
function metricsView(snapshot: {
  posterCount: number
  messageCount: number
  lurkerCount?: number | null
  participationRate?: number | null
  avgDwellSeconds?: number | null
  channelSplit?: { public?: number; private?: number } | null
  botInvocationCount: number
  spikeCount: number
  receptionCount?: number | null
}): SnapshotMetricsView {
  return {
    posterCount: snapshot.posterCount,
    messageCount: snapshot.messageCount,
    lurkerCount: snapshot.lurkerCount ?? null,
    participationRate: snapshot.participationRate ?? null,
    avgDwellSeconds: snapshot.avgDwellSeconds ?? null,
    channelSplit: { public: snapshot.channelSplit?.public ?? 0, private: snapshot.channelSplit?.private ?? 0 },
    botInvocationCount: snapshot.botInvocationCount,
    spikeCount: snapshot.spikeCount,
    receptionCount: snapshot.receptionCount ?? null
  }
}

/**
 * Walks the ended, non-experimental events whose end falls inside the age window (oldest-first)
 * and snapshots each one that had web analytics wired up. By default it skips events that
 * already have a snapshot for the current metrics version; with overwrite it recomputes and
 * replaces them. dryRun still computes each event's metrics so the preview shows what would be
 * written, but persists nothing. Returns a summary with the per-event before and after metrics.
 */
export async function backfillConversationMetricsSnapshots({
  dryRun = false,
  minAgeDays = 0,
  maxAgeDays,
  overwrite = false,
  now
}: BackfillOptions = {}): Promise<BackfillSummary> {
  const reference = (now ?? new Date()).getTime()
  // Older bound on endTime: the event must have ended at least minAgeDays ago.
  const endedBefore = new Date(reference - minAgeDays * MS_PER_DAY)
  // Newer bound: when maxAgeDays is set, the event must have ended within that many days.
  const endedAfter = maxAgeDays !== undefined ? new Date(reference - maxAgeDays * MS_PER_DAY) : null

  const endTimeFilter: Record<string, unknown> = { $exists: true, $ne: null, $lte: endedBefore }
  if (endedAfter) endTimeFilter.$gt = endedAfter

  const summary: BackfillSummary = {
    window: { minAgeDays, maxAgeDays: maxAgeDays ?? null },
    scanned: 0,
    backfilled: 0,
    skippedExisting: 0,
    skippedNoTrackedData: 0,
    events: []
  }

  // Loaded read-only with .lean(): the backfill only ever reads these conversations (its sole
  // write target is the snapshot collection), and a lean plain object has no .save(), so it
  // cannot accidentally persist a change back onto historical data. The downstream code reads
  // scalar fields only, so plain objects are enough.
  const conversations = await Conversation.find({
    endTime: endTimeFilter,
    experimental: { $ne: true }
  })
    .sort({ endTime: 1 })
    .lean()

  for (const conversation of conversations) {
    summary.scanned += 1

    const existing = await ConversationMetricsSnapshot.findOne({
      conversationId: conversation._id,
      metricsVersion: METRICS_VERSION
    })
    if (existing && !overwrite) {
      summary.skippedExisting += 1
      continue
    }

    const hasTrackedData = await ConversationAnalytics.exists({ conversationId: conversation._id })
    if (!hasTrackedData) {
      summary.skippedNoTrackedData += 1
      continue
    }

    const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
    // Build the payload either way so the dry-run preview shows the real would-be values; only
    // the write is gated on dryRun.
    const after = dryRun
      ? conversationMetricsSnapshotService.buildSnapshotPayload(conversation, metrics, { receptionCount: null })
      : await conversationMetricsSnapshotService.persistSnapshot(conversation, metrics, { receptionCount: null })

    summary.backfilled += 1
    summary.events.push({
      conversationId: conversation._id.toString(),
      name: conversation.name,
      endTime: conversation.endTime,
      before: existing ? metricsView(existing) : null,
      after: metricsView(after!)
    })
  }

  return summary
}

function parseNumberFlag(flag: string): number | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (!match) return undefined
  const value = Number(match.split('=')[1])
  if (Number.isNaN(value)) throw new Error(`${flag} must be a number`)
  return value
}

/* A compact one-line rendering of one event's before/after, so a batch reads at a glance. */
function formatEvent(event: BackfilledEvent): string {
  const field = (name: string, before: number | null, after: number | null) => {
    const a = after === null ? 'null' : after
    return event.before && before !== after ? `${name} ${before === null ? 'null' : before}->${a}` : `${name} ${a}`
  }
  const label = `${event.name ?? 'Past event'} (${event.endTime?.toISOString().slice(0, 10) ?? '?'})`
  const b = event.before
  const a = event.after
  const fields = [
    field('posters', b?.posterCount ?? null, a.posterCount),
    field('messages', b?.messageCount ?? null, a.messageCount),
    field('lurkers', b?.lurkerCount ?? null, a.lurkerCount),
    field('dwell', b?.avgDwellSeconds ?? null, a.avgDwellSeconds),
    field('spikes', b?.spikeCount ?? null, a.spikeCount),
    field('receptions', b?.receptionCount ?? null, a.receptionCount)
  ].join('  ')
  return `  ${label}: ${fields}`
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const overwrite = process.argv.includes('--overwrite')
  const minAgeDays = parseNumberFlag('--min-age-days') ?? 0
  const maxAgeDays = parseNumberFlag('--max-age-days')

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  const windowLabel = maxAgeDays !== undefined ? `${minAgeDays}-${maxAgeDays} days old` : `${minAgeDays}+ days old`
  console.log(`Connected to MongoDB. Batch: ${windowLabel}${dryRun ? ' (dry run, no writes)' : ''}`)

  try {
    const summary = await backfillConversationMetricsSnapshots({ dryRun, minAgeDays, maxAgeDays, overwrite })
    console.log(
      `Scanned ${summary.scanned} ended events: ` +
        `${dryRun ? 'would backfill' : 'backfilled'} ${summary.backfilled}, ` +
        `skipped ${summary.skippedExisting} already snapshotted, ` +
        `skipped ${summary.skippedNoTrackedData} with no web-analytics data.`
    )
    if (summary.events.length > 0) {
      console.log(dryRun ? 'Would write (before -> after):' : 'Wrote (before -> after):')
      for (const event of summary.events) console.log(formatEvent(event))
    }
  } finally {
    await mongoose.connection.close()
    console.log('Connection closed.')
    process.exit(0)
  }
}

// Only connect and run when invoked directly, so importing this module (e.g. in a test) does
// not open a database connection or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
