#!/usr/bin/env node
/**
 * Backfills a per-event metrics snapshot for past events, so the Vibes Analyst baseline and
 * history have something to read the moment this feature ships. Without it, every topic's
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
 * An event that already has a snapshot for the current metrics version is left untouched, so
 * the script is safe to re-run.
 *
 * USAGE:
 *   NODE_ENV=... node --loader ts-node/esm scripts/backfillEventMetricsSnapshots.ts [--dry-run]
 */
/* eslint-disable no-console */

import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import config from '../src/config/config.js'
import Conversation from '../src/models/conversation.model.js'
import ConversationAnalytics from '../src/models/conversationAnalytics.model.js'
import EventMetricsSnapshot from '../src/models/eventMetricsSnapshot.model.js'
import conversationAnalyticsService, { METRICS_VERSION } from '../src/services/conversationAnalytics.service.js'
import eventMetricsSnapshotService from '../src/services/eventMetricsSnapshot.service.js'

export interface BackfillSummary {
  scanned: number
  backfilled: number
  skippedExisting: number
  skippedNoTrackedData: number
}

/**
 * Walks every ended, non-experimental event oldest-first and writes a metrics snapshot for
 * each one that had web analytics wired up and does not already have a snapshot for the
 * current metrics version. Returns a summary of what it did. With dryRun set it computes the
 * same decisions and counts but writes nothing, so a run can be previewed first.
 */
export async function backfillEventMetricsSnapshots({
  dryRun = false
}: { dryRun?: boolean } = {}): Promise<BackfillSummary> {
  const summary: BackfillSummary = { scanned: 0, backfilled: 0, skippedExisting: 0, skippedNoTrackedData: 0 }

  const events = await Conversation.find({
    endTime: { $exists: true, $ne: null },
    experimental: { $ne: true }
  }).sort({ endTime: 1 })

  for (const conversation of events) {
    summary.scanned += 1

    const alreadyHasSnapshot = await EventMetricsSnapshot.exists({
      conversationId: conversation._id,
      metricsVersion: METRICS_VERSION
    })
    if (alreadyHasSnapshot) {
      summary.skippedExisting += 1
      continue
    }

    const hasTrackedData = await ConversationAnalytics.exists({ conversationId: conversation._id })
    if (!hasTrackedData) {
      summary.skippedNoTrackedData += 1
      continue
    }

    if (!dryRun) {
      const metrics = await conversationAnalyticsService.computeConversationMetrics(conversation)
      await eventMetricsSnapshotService.persistSnapshot(conversation, metrics, { receptionCount: null })
    }
    summary.backfilled += 1
  }

  return summary
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  mongoose.set('strict', true)
  await mongoose.connect(config.mongoose.url, config.mongoose.options)
  console.log(`Connected to MongoDB${dryRun ? ' (dry run, no writes)' : ''}`)

  try {
    const summary = await backfillEventMetricsSnapshots({ dryRun })
    console.log(
      `Scanned ${summary.scanned} ended events: ` +
        `${dryRun ? 'would backfill' : 'backfilled'} ${summary.backfilled}, ` +
        `skipped ${summary.skippedExisting} already snapshotted, ` +
        `skipped ${summary.skippedNoTrackedData} with no web-analytics data.`
    )
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
