import { jest } from '@jest/globals'
import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { ConversationMembership, MemberInvite } from '../../src/models/index.js'
import emailService from '../../src/services/email.service.js'
import inviteService from '../../src/services/invite.service.js'
import { inviteSendLimiter, inviteConsumeLimiter } from '../../src/middlewares/rateLimiter.js'
import { insertUsers, admin, participant } from '../fixtures/user.fixture.js'
import { adminAccessToken, participantAccessToken } from '../fixtures/token.fixture.js'
import { insertConversations, conversationCommunityRoom } from '../fixtures/conversation.fixture.js'

setupIntTest()

const sendUrl = (conversationId: unknown) => `/v1/members/${conversationId}/invites`
const resendUrl = (membershipId: unknown) => `/v1/members/invites/${membershipId}/resend`

const insertMembership = async (overrides = {}) =>
  ConversationMembership.create({
    conversation: conversationCommunityRoom._id,
    email: 'jane.doe@example.com',
    name: 'Jane Doe',
    bio: 'A bio',
    interests: 'Interests',
    ...overrides
  })

type BatchResult = Array<{ membershipId: string; success: boolean; error?: string }>
interface InvitePayload {
  membershipId: string
  to: string
  name: string
  roomName: string
  token: string
}
let batchSpy

describe('invite endpoints', () => {
  beforeEach(async () => {
    await insertUsers([admin, participant])
    await insertConversations([conversationCommunityRoom])
    // Same shared-limiter reset dance as members.test.ts: reset every loopback key
    // a supertest request can resolve to; unknown keys are a no-op.
    await Promise.all(
      ['::1', '127.0.0.1', '::ffff:127.0.0.1'].flatMap((key) => [
        inviteSendLimiter.resetKey(key),
        inviteConsumeLimiter.resetKey(key)
      ])
    )
  })

  afterEach(() => {
    if (batchSpy) {
      batchSpy.mockRestore()
      batchSpy = undefined
    }
  })

  const mockBatch = (impl?: (invites: InvitePayload[]) => BatchResult) => {
    batchSpy = jest
      .spyOn(emailService, 'sendMemberInviteBatch')
      .mockImplementation(async (invites: InvitePayload[]) =>
        impl ? impl(invites) : invites.map((i) => ({ membershipId: i.membershipId, success: true }))
      )
    return batchSpy
  }

  describe('POST /v1/members/:conversationId/invites (admin batch send)', () => {
    test('returns 401 with no auth token', async () => {
      await request(app).post(sendUrl(conversationCommunityRoom._id)).expect(httpStatus.UNAUTHORIZED)
    })

    test('returns 403 for a non-admin (participant) user', async () => {
      await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .expect(httpStatus.FORBIDDEN)
    })

    test('returns 404 when the conversation does not exist', async () => {
      await request(app)
        .post(sendUrl(new mongoose.Types.ObjectId()))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.NOT_FOUND)
    })

    test('mails every pending member once and marks them invited', async () => {
      const janeM = await insertMembership()
      const otherM = await insertMembership({ email: 'other@example.com', name: 'Other Person' })
      const spy = mockBatch()

      const res = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(res.body).toMatchObject({ sent: 2, failed: 0 })
      expect(spy).toHaveBeenCalledTimes(1)
      const invites = spy.mock.calls[0][0] as InvitePayload[]
      expect(invites).toHaveLength(2)
      expect(invites.map((i) => i.to).sort()).toEqual(['jane.doe@example.com', 'other@example.com'])
      expect(invites[0].roomName).toBe(conversationCommunityRoom.name)
      expect(invites[0].token).toEqual(expect.any(String))

      const jane = await ConversationMembership.findById(janeM._id).lean()
      const other = await ConversationMembership.findById(otherM._id).lean()
      expect(jane!.inviteState).toBe('invited')
      expect(other!.inviteState).toBe('invited')
    })

    test('never re-mails an already invited member', async () => {
      await insertMembership({ inviteState: 'invited' })
      const pending = await insertMembership({ email: 'pending@example.com', name: 'Pending Person' })
      const spy = mockBatch()

      const res = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(res.body.sent).toBe(1)
      const invites = spy.mock.calls[0][0] as InvitePayload[]
      expect(invites).toHaveLength(1)
      expect(invites[0].membershipId).toBe(pending._id.toString())
    })

    test('never mails a removed member', async () => {
      await insertMembership({ status: 'removed' })
      mockBatch()

      const res = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(res.body).toMatchObject({ sent: 0, failed: 0 })
      expect(batchSpy).not.toHaveBeenCalled()
    })

    test('records a per-recipient failure on the member record and reports it', async () => {
      const janeM = await insertMembership()
      const bouncedM = await insertMembership({ email: 'bounced@example.com', name: 'Bounced Person' })
      mockBatch((invites) =>
        invites.map((i) =>
          i.to === 'bounced@example.com'
            ? { membershipId: i.membershipId, success: false, error: 'hard bounce' }
            : { membershipId: i.membershipId, success: true }
        )
      )

      const res = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(res.body).toMatchObject({ sent: 1, failed: 1 })
      expect(res.body.failures).toEqual([
        expect.objectContaining({
          membershipId: bouncedM._id.toString(),
          email: 'bounced@example.com',
          error: 'hard bounce'
        })
      ])

      const jane = await ConversationMembership.findById(janeM._id).lean()
      const bounced = await ConversationMembership.findById(bouncedM._id).lean()
      expect(jane!.inviteState).toBe('invited')
      expect(bounced!.inviteState).toBe('failed')
      expect(bounced!.inviteError).toBe('hard bounce')
    })

    test('a later batch retries failed members but not invited ones', async () => {
      await insertMembership({ inviteState: 'invited' })
      const failedM = await insertMembership({
        email: 'failed@example.com',
        name: 'Failed Person',
        inviteState: 'failed',
        inviteError: 'hard bounce'
      })
      const spy = mockBatch()

      const res = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(res.body.sent).toBe(1)
      const invites = spy.mock.calls[0][0] as InvitePayload[]
      expect(invites[0].membershipId).toBe(failedM._id.toString())
      const failed = await ConversationMembership.findById(failedM._id).lean()
      expect(failed!.inviteState).toBe('invited')
      expect(failed!.inviteError).toBeFalsy()
    })

    test('returns 501 while the Postmark migration is outstanding, leaving members pending', async () => {
      const membership = await insertMembership()

      await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.NOT_IMPLEMENTED)

      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('pending')
    })
  })

  describe('POST /v1/members/invites/:membershipId/resend (admin resend)', () => {
    test('returns 401 with no auth token', async () => {
      await request(app).post(resendUrl(new mongoose.Types.ObjectId())).expect(httpStatus.UNAUTHORIZED)
    })

    test('returns 403 for a non-admin (participant) user', async () => {
      await request(app)
        .post(resendUrl(new mongoose.Types.ObjectId()))
        .set('Authorization', `Bearer ${participantAccessToken}`)
        .expect(httpStatus.FORBIDDEN)
    })

    test('returns 404 for an unknown membership', async () => {
      mockBatch()
      await request(app)
        .post(resendUrl(new mongoose.Types.ObjectId()))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.NOT_FOUND)
    })

    test('returns 400 when the member has already joined', async () => {
      const membership = await insertMembership({ joined: true, inviteState: 'invited' })
      mockBatch()

      await request(app)
        .post(resendUrl(membership._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.BAD_REQUEST)
    })

    test('invalidates the outstanding token and sends a fresh one', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const old = await inviteService.mintInvite(membership)
      const spy = mockBatch()

      await request(app)
        .post(resendUrl(membership._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      await expect(inviteService.validateInvite(old.token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
      const invites = spy.mock.calls[0][0] as InvitePayload[]
      expect(invites).toHaveLength(1)
      await expect(inviteService.validateInvite(invites[0].token)).resolves.toBeTruthy()
      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('invited')
    })
  })

  describe('GET /v1/auth/invite (public validate, no consume)', () => {
    test('returns the member greeting data and a nonce for a valid token', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)

      const res = await request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)

      expect(res.body.nonce).toEqual(expect.any(String))
      expect(res.body.member).toMatchObject({ name: 'Jane Doe', email: 'jane.doe@example.com' })
      expect(res.body.conversation).toMatchObject({ name: conversationCommunityRoom.name })
      // The response carries a live nonce; it must never be cached or leak a referrer.
      expect(res.headers['cache-control']).toContain('no-store')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    })

    test('does not consume: a scanner pre-open plus a real click both succeed', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)

      await request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)
      await request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)

      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeFalsy()
    })

    test('returns 401 for an invalid token and 400 for a missing one', async () => {
      await request(app).get('/v1/auth/invite').query({ token: 'garbage' }).expect(httpStatus.UNAUTHORIZED)
      await request(app).get('/v1/auth/invite').expect(httpStatus.BAD_REQUEST)
    })

    test('never leaks the token hash or nonce hash in the response', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)

      const res = await request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)

      const body = JSON.stringify(res.body)
      expect(body).not.toContain('tokenHash')
      expect(body).not.toContain('nonceHash')
    })
  })

  describe('POST /v1/auth/invite/consume (public consume)', () => {
    const getNonce = async (token: string) => {
      const res = await request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)
      return res.body.nonce as string
    }

    test('consumes with token plus nonce, and a second submit fails', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      const nonce = await getNonce(token)

      const res = await request(app).post('/v1/auth/invite/consume').send({ token, nonce }).expect(httpStatus.OK)
      expect(res.headers['cache-control']).toContain('no-store')

      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeTruthy()

      await request(app).post('/v1/auth/invite/consume').send({ token, nonce }).expect(httpStatus.UNAUTHORIZED)
    })

    test('a skimmed token alone cannot consume: nonce is required', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      await getNonce(token)

      await request(app).post('/v1/auth/invite/consume').send({ token }).expect(httpStatus.BAD_REQUEST)
      await request(app).post('/v1/auth/invite/consume').send({ token, nonce: 'wrong' }).expect(httpStatus.UNAUTHORIZED)

      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeFalsy()
    })
  })
})
