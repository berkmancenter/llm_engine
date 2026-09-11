import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

/* Number Cruncher's default cron moved from 3am UTC to 4am America/New_York when the
   nightly cost-snapshot sweep was folded onto the same trigger (the framework allows one
   cron trigger per agent, see src/agents/numberCruncher/agent.ts). Changing the agent
   type's `defaultTriggers` only affects agents created AFTER that ships: agent.model's
   pre('validate') fills `triggers` solely when it is undefined, so every already-saved
   Number Cruncher keeps the trigger it was created with.

   Rewriting the agent document alone is not enough either. The live schedule is a separate
   `agendaJobs` document carrying its own copy of the expression as `repeatInterval`, and
   boot-time recovery runs with `reschedule: false` (see the "Boot vs. reschedule" note in
   src/services/agent.service/index.ts), so `scheduleCronAgent` leaves an existing job
   exactly as it found it. Both documents have to move together or the agent's hello text
   advertises 4am ET while the job keeps firing at 3am UTC.

   This deletes the stale job rather than rewriting `repeatInterval` in place, because a
   rewritten job still carries the `nextRunAt` agenda computed from the OLD expression -
   agenda only recomputes it after a run, so an in-place edit buys one final fire at the
   old time. A deleted job is recreated from the (now-updated) trigger by the next boot's
   recovery path, which schedules it precisely because `cronAgentExists` is false.

   ORDER: run this and then deploy/restart, the way scripts/migrate.ts describes. Between
   the two, affected agents have no cron schedule at all - nothing fires, nothing is lost,
   and the first instance to boot recreates it. An environment that runs the migration but
   never restarts leaves them unscheduled, so don't run it detached from a deploy. */
const AGENT_TYPE = 'numberCruncher'
const OLD_TRIGGER = { expression: '0 3 * * *' }
const NEW_TRIGGER = { expression: '0 4 * * *', timezone: 'America/New_York' }

/* Only agents still sitting on the old DEFAULT are touched. An operator who hand-tuned a
   Number Cruncher to some other expression chose that deliberately; a blanket update keyed
   on agentType alone would silently overwrite it. */
async function retime(db: MigrationContext['db'], from: { expression: string }, to: Record<string, string>) {
  /* Agents are a discriminator on BaseUser, so they live in `baseusers`, not a collection
     of their own. Raw driver access on purpose - see the note in migrations/context.ts. */
  const agents = db.collection('baseusers')
  const ids = (
    await agents
      .find({ agentType: AGENT_TYPE, 'triggers.cron.expression': from.expression }, { projection: { _id: 1 } })
      .toArray()
  ).map((doc) => doc._id)

  if (ids.length === 0) return 0

  await agents.updateMany({ _id: { $in: ids } }, { $set: { 'triggers.cron': to } })

  /* data.agentId is written by schedule.cronAgent as the agent's ObjectId, but match the
     string form too: a job saved through a path that stringified it would otherwise be
     left behind, still firing on the old expression with nothing pointing at it. */
  await db.collection('agendaJobs').deleteMany({
    name: 'cronAgent',
    'data.agentId': { $in: [...ids, ...ids.map((id) => String(id))] }
  })

  return ids.length
}

export const up: MigrationFn<MigrationContext> = async ({ context: { db } }) => retime(db, OLD_TRIGGER, NEW_TRIGGER)

/* Same mechanics in reverse, and the same deploy-ordering caveat: the schedule is gone
   until something boots and recreates it from the reverted trigger. */
export const down: MigrationFn<MigrationContext> = async ({ context: { db } }) =>
  retime(db, NEW_TRIGGER, OLD_TRIGGER)

export default {
  name: '20260911000000-retime-number-cruncher-cron',
  up,
  down
}
