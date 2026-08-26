import fs from 'fs'
import path from 'path'
import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { ConversationMembership } from '../../src/models/index.js'
import { memberImportLimiter } from '../../src/middlewares/rateLimiter.js'
import { insertUsers, admin, participant } from '../fixtures/user.fixture.js'
import { adminAccessToken, participantAccessToken } from '../fixtures/token.fixture.js'
import { insertConversations, conversationCommunityRoom, conversationOne } from '../fixtures/conversation.fixture.js'

setupIntTest()

// eslint-disable-next-line security/detect-non-literal-fs-filename
const readCsv = (name: string) => fs.readFileSync(path.join('tests/fixtures/csv', name))
const CLEAN_CSV = readCsv('members-clean.csv')

const importUrl = (conversationId: unknown) => `/v1/members/${conversationId}/import`

describe('POST /v1/members/:conversationId/import', () => {
  beforeEach(async () => {
    await insertUsers([admin, participant])
    await insertConversations([conversationCommunityRoom, conversationOne])
    await ConversationMembership.syncIndexes()
    // The limiter is a process-lifetime singleton shared across every test in this file;
    // reset it so one test's calls never trip another's. Only resetKey(key) is exposed
    // (no resetAll), and the exact key a supertest request resolves to as req.ip varies
    // by loopback representation, so reset every one seen in practice; resetting a key
    // that was never hit is a harmless no-op.
    await Promise.all(['::1', '127.0.0.1', '::ffff:127.0.0.1'].map((key) => memberImportLimiter.resetKey(key)))
  })

  test('returns 401 with no auth token', async () => {
    await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.UNAUTHORIZED)
  })

  test('returns 403 for a non-admin (participant) user', async () => {
    await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${participantAccessToken}`)
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.FORBIDDEN)
  })

  test('returns 400 when conversationId is not a valid ObjectId', async () => {
    await request(app)
      .post(importUrl('not-an-object-id'))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.BAD_REQUEST)
  })

  test('returns 404 when the conversation does not exist', async () => {
    await request(app)
      .post(importUrl(new mongoose.Types.ObjectId()))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.NOT_FOUND)
  })

  test('returns 400 for a conversation type not eligible for member import', async () => {
    await request(app)
      .post(importUrl(conversationOne._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.BAD_REQUEST)
  })

  test('returns 400 for a file that is not valid UTF-8', async () => {
    // "Jos\xe9" (Windows-1252/Latin-1) is invalid UTF-8: 0xe9 alone has no lead byte.
    const invalidUtf8 = Buffer.concat([
      Buffer.from('First Name,Last Name,Email,Bio,Interests\n', 'utf8'),
      Buffer.from([0x4a, 0x6f, 0x73, 0xe9]),
      Buffer.from(',Garcia,jose.garcia@example.com,Bio,Interests\n', 'utf8')
    ])
    await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', invalidUtf8, 'members.csv')
      .expect(httpStatus.BAD_REQUEST)
  })

  test('returns 400 when no file is attached', async () => {
    await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(httpStatus.BAD_REQUEST)
  })

  test('imports a clean file and returns added/updated/skipped/failed counts', async () => {
    const res = await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.OK)

    expect(res.body).toMatchObject({ added: 5, updated: 0, skipped: 0, failed: 0, errors: [] })
    expect(res.body.newMembers).toHaveLength(5)
    expect(await ConversationMembership.countDocuments({ conversation: conversationCommunityRoom._id })).toBe(5)
  })

  test('maps a real-world file with varied header casing/spacing/wording', async () => {
    const res = await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', readCsv('members-messy-headers.csv'), 'members.csv')
      .expect(httpStatus.OK)

    expect(res.body).toMatchObject({ added: 5, failed: 0 })
    const ada = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com'
    }).lean()
    expect(ada?.name).toBe('Ada Lovelace')
  })

  test('sanitizes dirty rows, collapses an in-file duplicate, and reports a bad email without leaking its value', async () => {
    const res = await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', readCsv('members-duplicates-and-dirty.csv'), 'members.csv')
      .expect(httpStatus.OK)

    expect(res.body).toMatchObject({ added: 3, skipped: 1, failed: 1 })
    expect(res.body.errors).toEqual([{ row: 6, column: 'email', message: 'must be a valid email address' }])
    expect(JSON.stringify(res.body)).not.toContain('not-an-email')

    const bob = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'bob.sanitized@example.com'
    }).lean()
    expect(bob?.name).toBe('Bob Sanitized')
  })

  test('re-importing updates existing records by email instead of duplicating them, and never resets inviteState', async () => {
    await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', CLEAN_CSV, 'members.csv')
      .expect(httpStatus.OK)

    await ConversationMembership.updateOne(
      { conversation: conversationCommunityRoom._id, email: 'ada.lovelace@example.com' },
      { $set: { inviteState: 'invited' } }
    )

    const res = await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', readCsv('members-reimport-update.csv'), 'members.csv')
      .expect(httpStatus.OK)

    expect(res.body).toMatchObject({ added: 0, updated: 5 })
    expect(await ConversationMembership.countDocuments({ conversation: conversationCommunityRoom._id })).toBe(5)

    const ada = await ConversationMembership.findOne({
      conversation: conversationCommunityRoom._id,
      email: 'ada.lovelace@example.com'
    }).lean()
    expect(ada?.bio).toBe('Updated: pioneering computer programmer.')
    expect(ada?.inviteState).toBe('invited')
  })

  test('rejects a file over the 2MB cap', async () => {
    const oversized = Buffer.concat([CLEAN_CSV, Buffer.alloc(2 * 1024 * 1024, 'a')])
    const res = await request(app)
      .post(importUrl(conversationCommunityRoom._id))
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', oversized, 'members.csv')

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await ConversationMembership.countDocuments({ conversation: conversationCommunityRoom._id })).toBe(0)
  })

  test('rate limits the endpoint, active even outside production', async () => {
    // The limiter is process-lifetime and shared with every other test above; fire enough
    // requests to guarantee crossing max regardless of what's already been consumed here.
    const statuses: number[] = []
    for (let i = 0; i < 8; i += 1) {
      const res = await request(app)
        .post(importUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .attach('file', CLEAN_CSV, 'members.csv')
      statuses.push(res.status)
    }
    expect(statuses).toContain(httpStatus.TOO_MANY_REQUESTS)
  })
})
