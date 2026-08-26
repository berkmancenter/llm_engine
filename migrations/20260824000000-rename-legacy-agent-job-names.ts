import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

/* Agent job names used to be minted per agent (`periodic - <agentId>`, `cron - <agentId>`,
   `response - <agentId>`) rather than one name per job TYPE (see src/jobs/define.ts and
   src/jobs/schedule.ts for why that changed, and #262 for the boot-time cost it fixed).
   Every document under an old name already carries `data.agentId` - schedule.ts has always
   passed it as job data - so converting a document to the new scheme is a pure rename of
   `name`; nothing else about it changes.

   This has to run, in every environment that has ever scheduled an agent job, before the
   deploy that stops define()'ing the old per-agent names ships there: agenda's poller only
   processes a job name some live process has define()'d (see src/jobs/CLAUDE.md), so a job
   left under an old name the moment nothing defines it anymore is invisible to every
   instance, forever - no error, no alert, nothing in a Terraform diff. See scripts/migrate.ts
   for how to run this. */
const LEGACY_NAME_PATTERNS: Record<string, RegExp> = {
  periodicAgent: /^periodic - /,
  cronAgent: /^cron - /,
  agentResponse: /^response - /
}

const LEGACY_PREFIXES: Record<string, string> = {
  periodicAgent: 'periodic - ',
  cronAgent: 'cron - ',
  agentResponse: 'response - '
}

export const up: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const collection = db.collection('agendaJobs')
  let migrated = 0
  for (const [name, pattern] of Object.entries(LEGACY_NAME_PATTERNS)) {
    const result = await collection.updateMany({ name: pattern }, { $set: { name } })
    migrated += result.modifiedCount
  }
  return migrated
}

/* Best-effort revert: renames documents currently under a generic name back to the legacy
   `<prefix><agentId>` form. This is only exact for documents this migration's `up` actually
   touched - if `down` runs a long time after `up`, any job legitimately created under the
   new generic name in the meantime (any agent scheduled since) gets renamed back to a
   legacy name too, since nothing on the document distinguishes "migrated" from "created
   after migrating". Safe to run immediately after `up` (the only case umzug's own down
   command is for); not a general-purpose undo for a cluster that has been running the new
   scheme for a while. */
export const down: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const collection = db.collection('agendaJobs')
  for (const [name, prefix] of Object.entries(LEGACY_PREFIXES)) {
    const docs = await collection.find({ name }, { projection: { 'data.agentId': 1 } }).toArray()
    for (const doc of docs) {
      const agentId = (doc.data as { agentId?: unknown } | undefined)?.agentId
      if (agentId === undefined) continue
      await collection.updateOne({ _id: doc._id }, { $set: { name: `${prefix}${agentId}` } })
    }
  }
}

export default {
  name: '20260824000000-rename-legacy-agent-job-names',
  up,
  down
}
