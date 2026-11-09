import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

/* UnpackRequest gained a required `status` when the Unpacker learned to explain highlighted passages.
   "Catch me up" asks saved before that have none, and any code that loads and saves one would fail
   validation. Every one of them was answered when it was saved, so they are all `sent`. Reverting
   would need a backup: nothing on a backfilled row tells it apart from a row saved as `sent`. */

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
