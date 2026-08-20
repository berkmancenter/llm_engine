import mongoose from 'mongoose'
import logger from '../config/logger.js'

/* Agent job names used to be minted per agent (`periodic - <agentId>`, `cron - <agentId>`,
   `response - <agentId>`) rather than one name per job TYPE (see define.ts/schedule.ts for
   why that changed). Every document under an old name already carries `data.agentId` -
   schedule.ts has always passed it as job data - so converting a document to the new scheme
   is a pure rename of `name`; nothing else about it changes.

   This has to run before defineJob registers the new generic names, and before anything
   calls schedule.*Exists()/cancel*() against the new names, so a job that's still under an
   old name at the moment this ships gets found and renamed rather than silently orphaned:
   agenda's poller only processes a job name that some live process has define()'d (see
   jobs/CLAUDE.md), and once no process defines the old per-agent names anymore, a job left
   under one is invisible to every instance, forever - no error, no alert, nothing in a
   Terraform diff. That is exactly the failure class this migration exists to avoid
   reintroducing.

   Deliberately a function called from the boot path, not a one-off script someone has to
   remember to run - an automated, rolling deploy has no point at which a human naturally
   does that, and the gap between "new code is live" and "someone ran the script" is exactly
   the same silent-orphan window this is meant to close. Idempotent and cheap: each call is
   one indexed-prefix query per legacy name; once every instance has booted at least once
   after this ships, all three match nothing and stay a no-op indefinitely. */
const LEGACY_NAME_PATTERNS: Record<string, RegExp> = {
  periodicAgent: /^periodic - /,
  cronAgent: /^cron - /,
  agentResponse: /^response - /
}

export async function migrateLegacyAgentJobNames(): Promise<number> {
  const { db } = mongoose.connection
  if (!db) {
    logger.warn('migrateLegacyAgentJobNames: no active Mongo connection, skipping')
    return 0
  }
  const collection = db.collection('agendaJobs')

  let migrated = 0
  for (const [name, pattern] of Object.entries(LEGACY_NAME_PATTERNS)) {
    const result = await collection.updateMany({ name: pattern }, { $set: { name } })
    if (result.modifiedCount > 0) {
      logger.info(`Migrated ${result.modifiedCount} legacy agenda job(s) matching ${pattern} to "${name}"`)
      migrated += result.modifiedCount
    }
  }
  return migrated
}

// Exported as an object (matching define.ts/schedule.ts) rather than a bare default export
// so callers can jest.spyOn() it the same way they already do for defineJob/schedule.
export default { migrateLegacyAgentJobNames }
