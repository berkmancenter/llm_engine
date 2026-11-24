import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

// An Unpacker ask now keeps a list of destinations, since one person can send a passage to
// Private Chat and later share it to Group Chat. There is no down: a row with two destinations
// can't be turned back into one.

export const up: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const asks = db.collection('unpackrequests')
  const moved = await asks.updateMany({ destination: { $exists: true } }, [
    { $set: { destinations: ['$destination'] } },
    { $unset: 'destination' }
  ])
  const emptied = await asks.updateMany({ destinations: { $exists: false } }, { $set: { destinations: [] } })
  return moved.modifiedCount + emptied.modifiedCount
}

export default {
  name: '20261123000000-unpack-request-destinations',
  up
}
