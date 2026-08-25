import mongoose from 'mongoose'
import migration from '../../migrations/20260825000000-migrate-legacy-user-roles.js'
import setupIntTest from '../utils/setupIntTest.js'

/* Regression coverage for the one-time cleanup #278 needs applied to data already sitting in
   Mongo: `createUser` used to force `role: 'admin'` on every account, and the `user` role
   value was renamed to `participant` in code without touching existing documents. See the
   migration file for the full rationale. */
setupIntTest()

const baseUsers = () => mongoose.connection.db!.collection('baseusers')
const context = () => ({ db: mongoose.connection.db! })
const params = (name: string) => ({ name, context: context(), path: undefined })

const legacyUser = (overrides: Record<string, unknown> = {}) => ({
  __t: 'User',
  username: 'someone',
  pseudonyms: [],
  role: 'admin',
  ...overrides
})

describe('migrate-legacy-user-roles migration', () => {
  test('up demotes an admin with no password to participant', async () => {
    const { insertedId } = await baseUsers().insertOne(legacyUser({ email: 'guest@cyber.harvard.edu' }))

    const migrated = await migration.up(params(migration.name))

    expect((migrated as { demotedAdmins: number }).demotedAdmins).toBe(1)
    expect((await baseUsers().findOne({ _id: insertedId }))!.role).toBe('participant')
  })

  test('up demotes an admin with a password but an email outside the preserved domains', async () => {
    const { insertedId } = await baseUsers().insertOne(
      legacyUser({ password: 'hashed-value', email: 'someone@example.com' })
    )

    await migration.up(params(migration.name))

    expect((await baseUsers().findOne({ _id: insertedId }))!.role).toBe('participant')
  })

  test('up demotes an admin with a preserved-domain email but no password', async () => {
    const { insertedId } = await baseUsers().insertOne(legacyUser({ email: 'someone@law.harvard.edu' }))

    await migration.up(params(migration.name))

    expect((await baseUsers().findOne({ _id: insertedId }))!.role).toBe('participant')
  })

  test('up keeps admin for a password-holding account on a preserved domain, either domain', async () => {
    const { insertedId: cyberId } = await baseUsers().insertOne(
      legacyUser({ password: 'hashed-value', email: 'staff@cyber.harvard.edu' })
    )
    const { insertedId: lawId } = await baseUsers().insertOne(
      legacyUser({ password: 'hashed-value', email: 'staff@law.harvard.edu' })
    )

    const migrated = await migration.up(params(migration.name))

    expect((migrated as { demotedAdmins: number }).demotedAdmins).toBe(0)
    expect((await baseUsers().findOne({ _id: cyberId }))!.role).toBe('admin')
    expect((await baseUsers().findOne({ _id: lawId }))!.role).toBe('admin')
  })

  test('up does not touch a non-admin role or an Agent document', async () => {
    const { insertedId: participantId } = await baseUsers().insertOne(
      legacyUser({ role: 'participant', email: 'someone@example.com' })
    )
    const { insertedId: agentId } = await baseUsers().insertOne({
      __t: 'Agent',
      role: 'admin',
      email: 'someone@example.com'
    })

    await migration.up(params(migration.name))

    expect((await baseUsers().findOne({ _id: participantId }))!.role).toBe('participant')
    expect((await baseUsers().findOne({ _id: agentId }))!.role).toBe('admin')
  })

  test('up renames the legacy user role to participant regardless of email or password', async () => {
    const { insertedId } = await baseUsers().insertOne(legacyUser({ role: 'user', email: undefined }))

    const migrated = await migration.up(params(migration.name))

    expect((migrated as { renamedLegacyUsers: number }).renamedLegacyUsers).toBe(1)
    expect((await baseUsers().findOne({ _id: insertedId }))!.role).toBe('participant')
  })

  test('up is idempotent: a second run after a successful migration is a no-op', async () => {
    await baseUsers().insertOne(legacyUser({ email: 'someone@example.com' }))
    await baseUsers().insertOne(legacyUser({ role: 'user' }))

    const first = await migration.up(params(migration.name))
    const second = await migration.up(params(migration.name))

    expect(first).toEqual({ demotedAdmins: 1, renamedLegacyUsers: 1 })
    expect(second).toEqual({ demotedAdmins: 0, renamedLegacyUsers: 0 })
  })
})
