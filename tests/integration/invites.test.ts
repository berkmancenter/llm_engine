import { jest } from '@jest/globals'
import request from 'supertest'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { applyTrustProxy } from '../../src/middlewares/trustProxy.js'
import { ConversationMembership, MemberInvite, User, Conversation } from '../../src/models/index.js'
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

    test('never mails a member who has already joined, even if never invited', async () => {
      await insertMembership({ joined: true, inviteState: 'pending' })
      mockBatch()

      const res = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(res.body).toMatchObject({ sent: 0, failed: 0 })
      expect(batchSpy).not.toHaveBeenCalled()
    })

    test('rejects a second send for the same conversation while one is in flight', async () => {
      await insertMembership()
      let releaseSend: (value: BatchResult) => void = () => {}
      batchSpy = jest.spyOn(emailService, 'sendMemberInviteBatch').mockImplementation(
        (invites: InvitePayload[]) =>
          new Promise<BatchResult>((resolve) => {
            releaseSend = () => resolve(invites.map((i) => ({ membershipId: i.membershipId, success: true })))
          })
      )

      const first = request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
      const firstStarted = first.then((r) => r)
      // Give the first request time to reach the mocked send before firing the second.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const second = await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
      expect(second.status).toBe(httpStatus.CONFLICT)

      releaseSend([])
      const firstRes = await firstStarted
      expect(firstRes.status).toBe(httpStatus.OK)
      expect(batchSpy).toHaveBeenCalledTimes(1)
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

    test('calls sendMemberInviteBatch with the correct shape and marks members invited', async () => {
      const membership = await insertMembership()
      const spy = mockBatch()

      await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)

      expect(spy).toHaveBeenCalledTimes(1)
      const invites = spy.mock.calls[0][0] as InvitePayload[]
      expect(invites).toHaveLength(1)
      expect(invites[0].membershipId).toBe(membership._id.toString())
      expect(invites[0].to).toBe(membership.email)
      expect(typeof invites[0].token).toBe('string')

      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('invited')
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
        statusCode: httpStatus.GONE
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
      expect(res.body.member).toMatchObject({ name: 'Jane Doe', hasAccount: false })
      expect(res.body.member.email).toBeUndefined()
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

    test('returns 410 for an invalid token and 400 for a missing one', async () => {
      await request(app).get('/v1/auth/invite').query({ token: 'garbage' }).expect(httpStatus.GONE)
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
    const password = 'Invite1234'
    const getNonce = async (token: string) => {
      const res = await request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)
      return res.body.nonce as string
    }

    test('consumes with token, nonce, and password; provisions account; returns auth tokens', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      const nonce = await getNonce(token)

      const res = await request(app).post('/v1/auth/invite/consume').send({ token, nonce, password }).expect(httpStatus.OK)
      expect(res.headers['cache-control']).toContain('no-store')
      // Matches /auth/login's response shape so the set-password page can start a session
      // the same way login does
      expect(res.body.user).toMatchObject({
        id: expect.any(String),
        email: membership.email,
        pseudonyms: expect.arrayContaining([expect.objectContaining({ active: true })])
      })
      expect(res.body.user.password).toBeUndefined()
      expect(res.body.tokens).toMatchObject({
        access: { token: expect.any(String), expires: expect.anything() },
        refresh: { token: expect.any(String), expires: expect.anything() }
      })
      expect(res.body.conversationId).toBe(conversationCommunityRoom._id.toString())
      expect(res.body.membership).toBeUndefined()
      expect(res.body.invite).toBeUndefined()

      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeTruthy()

      await request(app).post('/v1/auth/invite/consume').send({ token, nonce, password }).expect(httpStatus.GONE)
    })

    test('a skimmed token alone cannot consume: nonce and password are required', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      await getNonce(token)

      await request(app).post('/v1/auth/invite/consume').send({ token, password }).expect(httpStatus.BAD_REQUEST)
      await request(app).post('/v1/auth/invite/consume').send({ token, nonce: 'wrong' }).expect(httpStatus.BAD_REQUEST)
      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token, nonce: 'wrong', password })
        .expect(httpStatus.FORBIDDEN)

      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeFalsy()
    })

    test('rejects an injected role or real-name flag rather than honoring it', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      const nonce = await getNonce(token)

      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token, nonce, password, role: 'admin' })
        .expect(httpStatus.BAD_REQUEST)
      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token, nonce, password, isRealName: true })
        .expect(httpStatus.BAD_REQUEST)
      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token, nonce, password, conversations: ['000000000000000000000000'] })
        .expect(httpStatus.BAD_REQUEST)

      // Neither attempt should have burned the invite or created an account.
      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeFalsy()
      expect(await User.findOne({ email: membership.email })).toBeNull()

      // The invite is still good for a legitimate follow-up request.
      await request(app).post('/v1/auth/invite/consume').send({ token, nonce, password }).expect(httpStatus.OK)
      const user = await User.findOne({ email: membership.email })
      expect(user!.role).toBe('participant')
    })

    test('rejects a password that fails the strength check, and does not burn the invite', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      const nonce = await getNonce(token)

      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token, nonce, password: 'short1' })
        .expect(httpStatus.BAD_REQUEST)

      const invite = await MemberInvite.findOne({ membership: membership._id }).lean()
      expect(invite!.consumedAt).toBeFalsy()
    })

    test('invited guest can log in again with email and password after first entry', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      const nonce = await getNonce(token)
      await request(app).post('/v1/auth/invite/consume').send({ token, nonce, password }).expect(httpStatus.OK)

      const loginRes = await request(app)
        .post('/v1/auth/login')
        .send({ username: membership.email, password })
        .expect(httpStatus.OK)
      expect(loginRes.body.tokens).toMatchObject({
        access: { token: expect.any(String) },
        refresh: { token: expect.any(String) }
      })
    })

    test('a second invite for an already-provisioned email reports hasAccount and requires the real password', async () => {
      const email = 'second.room@example.com'
      const membershipA = await insertMembership({ email })
      const tokenA = (await inviteService.mintInvite(membershipA)).token
      const nonceA = await getNonce(tokenA)
      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token: tokenA, nonce: nonceA, password })
        .expect(httpStatus.OK)

      const secondRoom = await Conversation.create({
        name: 'Second Room',
        owner: new mongoose.Types.ObjectId(),
        topic: new mongoose.Types.ObjectId(),
        conversationType: 'communityRoom',
        messages: [],
        transcript: { status: 'stopped' }
      })
      const membershipB = await insertMembership({ email, conversation: secondRoom._id })
      const tokenB = (await inviteService.mintInvite(membershipB)).token
      const getRes = await request(app).get('/v1/auth/invite').query({ token: tokenB }).expect(httpStatus.OK)
      expect(getRes.body.member).toMatchObject({ hasAccount: true })
      const nonceB = getRes.body.nonce as string

      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token: tokenB, nonce: nonceB, password: 'WrongPassword1' })
        .expect(httpStatus.UNAUTHORIZED)
      const stored = await MemberInvite.findOne({ membership: membershipB._id }).lean()
      expect(stored!.consumedAt).toBeFalsy()

      const res = await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token: tokenB, nonce: nonceB, password })
        .expect(httpStatus.OK)
      expect(res.body.user.email).toBe(email)
      expect(await User.countDocuments({ email })).toBe(1)
    })
  })

  describe('behind reverse proxies', () => {
    const proxyIps = ['192.0.2.10', '192.0.2.20']
    const visitorA = '198.51.100.1'
    const visitorB = '198.51.100.2'
    // Each proxy appends the address it received from, after anything the visitor sent.
    const forwardedFor = (visitorIp: string, visitorSupplied?: string) =>
      [visitorSupplied, visitorIp, ...proxyIps].filter(Boolean).join(', ')
    const validateFrom = (forwarded: string) =>
      request(app).get('/v1/auth/invite').set('X-Forwarded-For', forwarded).query({ token: 'not-a-jwt' })
    const spendAllowance = async (forwarded: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await validateFrom(forwarded)
      }
    }

    beforeEach(async () => {
      applyTrustProxy(app, 3)
      await Promise.all([visitorA, visitorB].map((key) => inviteConsumeLimiter.resetKey(key)))
    })

    afterEach(() => {
      app.set('trust proxy', false)
    })

    test('leaves forwarded headers untrusted when no proxy hops are configured', () => {
      app.set('trust proxy', false)

      applyTrustProxy(app, 0)

      expect(app.get('trust proxy')).toBe(false)
    })

    test('gives each visitor their own allowance instead of one shared through the proxies', async () => {
      await spendAllowance(forwardedFor(visitorA))

      const limited = await validateFrom(forwardedFor(visitorA))
      const other = await validateFrom(forwardedFor(visitorB))

      expect(limited.status).toBe(httpStatus.TOO_MANY_REQUESTS)
      expect(other.status).not.toBe(httpStatus.TOO_MANY_REQUESTS)
    })

    test('ignores addresses a visitor adds to the header to dodge the limit', async () => {
      await spendAllowance(forwardedFor(visitorA, '203.0.113.1'))

      const res = await validateFrom(forwardedFor(visitorA, '203.0.113.99'))

      expect(res.status).toBe(httpStatus.TOO_MANY_REQUESTS)
    })
  })
})
