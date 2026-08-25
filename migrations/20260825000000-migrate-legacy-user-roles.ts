import type { MigrationFn } from 'umzug'
import type { MigrationContext } from './context.js'

/* Two cleanups #278 needs applied to every environment's existing data, since that PR only
   changes what NEW documents get - it does not touch documents already sitting in Mongo:

   1. Demote legacy admins. `createUser` forced `role: 'admin'` on every account until #278,
      so every account ever registered - including auto-registered guests from pseudonymous
      events - is an admin today. Keep admin only for accounts that can actually prove they
      belong to the org running the platform: a password (so the account can be logged into
      deliberately, as opposed to a token-only guest) and an email on one of the org's own
      domains. Everyone else goes to `participant`, the new least-privilege default. Accounts
      are demoted, never deleted, because messages reference their author.

   2. Rename the old `user` role value to `participant`. `user` was the role name #278
      renamed in code (see src/config/roles.ts); documents written before that deploy (the
      adapter path, which never authenticates so this half is cleanup rather than urgent)
      still carry the old string and need it rewritten to match the roles enum User
      documents validate against today.

   Both operations only touch the `User` discriminator (`__t: 'User'`) in the shared
   `baseusers` collection - `Agent` documents in the same collection have no `role` field at
   all, so leaving off that filter would still be a no-op for them, but the filter documents
   the intent.

   This is a one-way migration: once a document's `role` has been rewritten, nothing on it
   distinguishes "was admin, demoted by this migration" from "was already participant" or
   "became participant some other way after this ran" - the same ambiguity the agenda job
   rename migration's `down` comment describes, except there's no side field (like
   `data.agentId`) here to reconstruct the prior value from. Reverting requires restoring
   from a database backup taken before this ran, not a `down` migration. */

const PRESERVED_ADMIN_EMAIL_DOMAINS = /@(cyber|law)\.harvard\.edu$/i

export const up: MigrationFn<MigrationContext> = async ({ context: { db } }) => {
  const collection = db.collection('baseusers')

  const demoted = await collection.updateMany(
    {
      __t: 'User',
      role: 'admin',
      $nor: [
        {
          password: { $exists: true, $type: 'string', $ne: '' },
          email: { $regex: PRESERVED_ADMIN_EMAIL_DOMAINS }
        }
      ]
    },
    { $set: { role: 'participant' } }
  )

  const renamed = await collection.updateMany({ __t: 'User', role: 'user' }, { $set: { role: 'participant' } })

  return { demotedAdmins: demoted.modifiedCount, renamedLegacyUsers: renamed.modifiedCount }
}

export default {
  name: '20260825000000-migrate-legacy-user-roles',
  up
}
