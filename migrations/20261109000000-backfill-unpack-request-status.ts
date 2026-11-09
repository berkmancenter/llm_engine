import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

// "Catch me up" asks saved before `status` was required fail validation when re-saved.
// Each was answered when saved, so they are all `sent`. There is no down: a backfilled
// row can't be told apart from one saved as `sent`.

export const up: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const backfilled = await db
    .collection('unpackrequests')
    .updateMany({ status: { $exists: false } }, { $set: { status: 'sent' } })
  return backfilled.modifiedCount
}

export default {
  name: '20261109000000-backfill-unpack-request-status',
  up
}
