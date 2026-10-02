import { jest } from '@jest/globals'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import moment from 'moment'
import { createHash, randomUUID } from 'node:crypto'
import httpStatus from 'http-status'
import mongoose from 'mongoose'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import config from '../../src/config/config.js'
import tokenTypes from '../../src/config/tokens.js'
import { ConversationMembership, MemberInvite, User, Conversation } from '../../src/models/index.js'
import emailService from '../../src/services/email.service.js'
import inviteService from '../../src/services/invite.service.js'
import tokenService from '../../src/services/token.service.js'
import agenda from '../../src/jobs/index.js'
import inviteHandlers from '../../src/jobs/handlers/invite.js'
import { inviteSendLimiter, inviteConsumeLimiter, inviteResendLimiter } from '../../src/middlewares/rateLimiter.js'
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

type BatchResult = Array<{ membershipId: string; success: boolean; error?: string; retryable?: boolean }>
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
        inviteConsumeLimiter.resetKey(key),
        inviteResendLimiter.resetKey(key)
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

    test('leaves no live link and marks everyone failed when the send throws', async () => {
      const janeM = await insertMembership()
      const otherM = await insertMembership({ email: 'other@example.com', name: 'Other Person' })
      batchSpy = jest.spyOn(emailService, 'sendMemberInviteBatch').mockRejectedValue(new Error('smtp down'))

      await request(app)
        .post(sendUrl(conversationCommunityRoom._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.INTERNAL_SERVER_ERROR)

      const undelivered = batchSpy.mock.calls[0][0] as InvitePayload[]
      expect(undelivered).toHaveLength(2)
      await Promise.all(
        undelivered.map(({ token }) => request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.GONE))
      )
      const jane = await ConversationMembership.findById(janeM._id).lean()
      const other = await ConversationMembership.findById(otherM._id).lean()
      expect(jane!.inviteState).toBe('failed')
      expect(other!.inviteState).toBe('failed')
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

    test('leaves no live link and marks the member failed when the send throws', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      batchSpy = jest.spyOn(emailService, 'sendMemberInviteBatch').mockRejectedValue(new Error('smtp down'))

      await request(app)
        .post(resendUrl(membership._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.INTERNAL_SERVER_ERROR)

      const [undelivered] = batchSpy.mock.calls[0][0] as InvitePayload[]
      await request(app).get('/v1/auth/invite').query({ token: undelivered.token }).expect(httpStatus.GONE)
      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('failed')
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

  describe('POST /v1/auth/invite/resend (public "send me a new link")', () => {
    const publicResendUrl = '/v1/auth/invite/resend'
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    let acceptedBody: unknown

    const resetResendLimiter = () =>
      Promise.all(['::1', '127.0.0.1', '::ffff:127.0.0.1'].map((key) => inviteResendLimiter.resetKey(key)))

    // setupIntTest only wipes collections with a Mongoose model, so queued jobs need clearing by hand.
    const clearQueuedResends = () => agenda.cancel({ name: 'publicInviteResend' })

    /* Agenda isn't polling under test, so run whatever the endpoint queued by hand, whatever
       its scheduled time. Returns how many jobs ran. */
    const runQueuedResends = async () => {
      const jobs = await agenda.jobs({ name: 'publicInviteResend' })
      await clearQueuedResends()
      for (const job of jobs) {
        await inviteHandlers.publicInviteResend(job)
      }
      return jobs.length
    }

    const signInviteJwt = (membershipId: string, issuedAt: moment.Moment, expiresAt: moment.Moment) =>
      jwt.sign(
        {
          sub: membershipId,
          jti: randomUUID(),
          type: tokenTypes.MEMBER_INVITE,
          iat: issuedAt.unix(),
          exp: expiresAt.unix()
        },
        config.jwt.secret,
        { algorithm: 'HS256' }
      )

    // mintInvite can only produce a live token, so build the expired one it would have made.
    const insertExpiredInvite = async (membership) => {
      const expiredAt = moment().subtract(1, 'day')
      const token = signInviteJwt(
        membership._id.toString(),
        moment().subtract(config.jwt.inviteExpirationDays + 1, 'days'),
        expiredAt
      )
      await MemberInvite.create({ membership: membership._id, tokenHash: sha256(token), expiresAt: expiredAt.toDate() })
      return token
    }

    const postPublicResend = async (body: object) => {
      const res = await request(app).post(publicResendUrl).send(body).expect(httpStatus.ACCEPTED)
      expect(res.body).toEqual(acceptedBody)
      expect(res.headers['cache-control']).toContain('no-store')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
      // Rate-limit headers would make a limited response look different from the rest.
      expect(res.headers['retry-after']).toBeUndefined()
      expect(res.headers['x-ratelimit-limit']).toBeUndefined()
      expect(res.headers['ratelimit-limit']).toBeUndefined()
      return res
    }

    const expectInviteLive = (token: string) => request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.OK)
    const expectInviteDead = (token: string) => request(app).get('/v1/auth/invite').query({ token }).expect(httpStatus.GONE)

    const failEverySend = (retryable: boolean) => async (invites: InvitePayload[]) =>
      invites.map((i) => ({ membershipId: i.membershipId, success: false, error: 'send failed', retryable }))

    beforeEach(async () => {
      await clearQueuedResends()
      // Every outcome must return this same body, so take it from the least informative one.
      const res = await request(app).post(publicResendUrl).send({ token: 'not-a-jwt' }).expect(httpStatus.ACCEPTED)
      acceptedBody = res.body
      await resetResendLimiter()
    })

    afterAll(clearQueuedResends)

    test('queues and then mails a fresh invite for an expired one, to the address on file', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      const spy = mockBatch()

      await postPublicResend({ token: expiredToken })
      expect(spy).not.toHaveBeenCalled()
      expect(await runQueuedResends()).toBe(1)

      expect(spy).toHaveBeenCalledTimes(1)
      const invites = spy.mock.calls[0][0] as InvitePayload[]
      expect(invites).toHaveLength(1)
      expect(invites[0]).toMatchObject({ membershipId: membership._id.toString(), to: 'jane.doe@example.com' })
      await expectInviteLive(invites[0].token)
      await expectInviteDead(expiredToken)
      expect(await MemberInvite.countDocuments({ membership: membership._id, invalidatedAt: null })).toBe(1)
    })

    test('mints and mails a fresh invite for one an admin resend replaced, killing the replacement', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const { token: supersededToken } = await inviteService.mintInvite(membership)
      const spy = mockBatch()
      await request(app)
        .post(resendUrl(membership._id))
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(httpStatus.OK)
      const adminToken = (spy.mock.calls[0][0] as InvitePayload[])[0].token

      await postPublicResend({ token: supersededToken })
      await runQueuedResends()

      expect(spy).toHaveBeenCalledTimes(2)
      const invites = spy.mock.calls[1][0] as InvitePayload[]
      expect(invites).toHaveLength(1)
      expect(invites[0].to).toBe('jane.doe@example.com')
      await expectInviteLive(invites[0].token)
      await expectInviteDead(adminToken)
      await expectInviteDead(supersededToken)
    })

    test('sends nothing for an invite that was already used', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const { token } = await inviteService.mintInvite(membership)
      const { nonce } = (await expectInviteLive(token)).body
      await request(app).post('/v1/auth/invite/consume').send({ token, nonce, password: 'Invite1234' }).expect(httpStatus.OK)
      const spy = mockBatch()

      await postPublicResend({ token })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('sends nothing for a superseded invite once the member has used its replacement', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const { token: supersededToken } = await inviteService.mintInvite(membership)
      const { token: replacementToken } = await inviteService.mintInvite(membership)
      const { nonce } = (await expectInviteLive(replacementToken)).body
      await request(app)
        .post('/v1/auth/invite/consume')
        .send({ token: replacementToken, nonce, password: 'Invite1234' })
        .expect(httpStatus.OK)
      const spy = mockBatch()

      await postPublicResend({ token: supersededToken })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('sends nothing for a member who already joined through another channel', async () => {
      const membership = await insertMembership({ inviteState: 'invited', joined: true })
      const expiredToken = await insertExpiredInvite(membership)
      const spy = mockBatch()

      await postPublicResend({ token: expiredToken })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('sends nothing and mints nothing for a tampered token', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const { token } = await inviteService.mintInvite(membership)
      // Flip a character mid-signature: the last one partly holds padding bits the decoder ignores.
      const [header, payload, signature] = token.split('.')
      const flipped = signature[10] === 'A' ? 'B' : 'A'
      const tampered = `${header}.${payload}.${signature.slice(0, 10)}${flipped}${signature.slice(11)}`
      const spy = mockBatch()

      await postPublicResend({ token: tampered })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
      await expectInviteLive(token)
    })

    test('sends nothing for a token of a different type, even one with a matching record', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const resetToken = tokenService.generateToken(
        membership._id.toString(),
        moment().add(1, 'day'),
        tokenTypes.RESET_PASSWORD
      )
      await MemberInvite.create({
        membership: membership._id,
        tokenHash: sha256(resetToken),
        expiresAt: moment().add(1, 'day').toDate()
      })
      const spy = mockBatch()

      await postPublicResend({ token: resetToken })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('sends nothing for a genuine invite token with no matching record', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const orphanToken = signInviteJwt(membership._id.toString(), moment(), moment().add(1, 'day'))
      const spy = mockBatch()

      await postPublicResend({ token: orphanToken })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('sends nothing once the membership has been removed', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      await ConversationMembership.updateOne({ _id: membership._id }, { status: 'removed' })
      const spy = mockBatch()

      await postPublicResend({ token: expiredToken })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('sends nothing when the membership is removed after the request was queued', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      const spy = mockBatch()

      await postPublicResend({ token: expiredToken })
      await ConversationMembership.updateOne({ _id: membership._id }, { status: 'removed' })
      await runQueuedResends()

      expect(spy).not.toHaveBeenCalled()
    })

    test('sends only once when asked again inside the cooldown', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      const spy = mockBatch()

      await postPublicResend({ token: expiredToken })
      await postPublicResend({ token: expiredToken })
      expect(await runQueuedResends()).toBe(1)

      expect(spy).toHaveBeenCalledTimes(1)
    })

    test('never sends to an email address supplied in the request', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      const spy = mockBatch()

      await request(app)
        .post(publicResendUrl)
        .send({ token: expiredToken, email: 'intruder@example.com' })
        .expect(httpStatus.BAD_REQUEST)

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })

    test('retries a temporary Postmark failure and delivers on the next attempt', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      batchSpy = jest
        .spyOn(emailService, 'sendMemberInviteBatch')
        .mockImplementationOnce(failEverySend(true))
        .mockImplementation(async (invites: InvitePayload[]) =>
          invites.map((i) => ({ membershipId: i.membershipId, success: true }))
        )

      await postPublicResend({ token: expiredToken })
      await runQueuedResends()

      const [retry] = await agenda.jobs({ name: 'publicInviteResend' })
      expect(retry.attrs.data).toEqual({ membershipId: membership._id.toString(), attempt: 2 })
      expect(retry.attrs.nextRunAt!.getTime()).toBeGreaterThan(Date.now())
      const [firstAttempt] = batchSpy.mock.calls[0][0] as InvitePayload[]
      await expectInviteDead(firstAttempt.token)

      await runQueuedResends()

      expect(batchSpy).toHaveBeenCalledTimes(2)
      const [delivered] = batchSpy.mock.calls[1][0] as InvitePayload[]
      await expectInviteLive(delivered.token)
      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('invited')
    })

    test('gives up after the last retry and lets the member ask again right away', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      batchSpy = jest.spyOn(emailService, 'sendMemberInviteBatch').mockImplementation(failEverySend(true))

      await postPublicResend({ token: expiredToken })
      while ((await runQueuedResends()) > 0) {
        // Each run either queues the next retry or gives up.
      }

      expect(batchSpy).toHaveBeenCalledTimes(3)
      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('failed')
      await postPublicResend({ token: expiredToken })
      expect(await agenda.jobs({ name: 'publicInviteResend' })).toHaveLength(1)
    })

    test('does not retry a recipient Postmark rejects, and lets the member ask again right away', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      batchSpy = jest.spyOn(emailService, 'sendMemberInviteBatch').mockImplementation(failEverySend(false))

      await postPublicResend({ token: expiredToken })
      await runQueuedResends()

      expect(batchSpy).toHaveBeenCalledTimes(1)
      expect(await agenda.jobs({ name: 'publicInviteResend' })).toHaveLength(0)
      const [undelivered] = batchSpy.mock.calls[0][0] as InvitePayload[]
      await expectInviteDead(undelivered.token)
      await postPublicResend({ token: expiredToken })
      expect(await agenda.jobs({ name: 'publicInviteResend' })).toHaveLength(1)
    })

    test('does not retry a failure on our side, and leaves no undelivered live link', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      batchSpy = jest
        .spyOn(emailService, 'sendMemberInviteBatch')
        .mockRejectedValue(new Error('Outgoing email is not configured'))

      await postPublicResend({ token: expiredToken })
      await runQueuedResends()

      expect(batchSpy).toHaveBeenCalledTimes(1)
      expect(await agenda.jobs({ name: 'publicInviteResend' })).toHaveLength(0)
      const [undelivered] = batchSpy.mock.calls[0][0] as InvitePayload[]
      await expectInviteDead(undelivered.token)
      const stored = await ConversationMembership.findById(membership._id).lean()
      expect(stored!.inviteState).toBe('failed')
    })

    test('answers the same without queuing once the per-IP limit is spent', async () => {
      const membership = await insertMembership({ inviteState: 'invited' })
      const expiredToken = await insertExpiredInvite(membership)
      const spy = mockBatch()
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await postPublicResend({ token: 'not-a-jwt' })
      }

      await postPublicResend({ token: expiredToken })

      expect(await runQueuedResends()).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    })
  })
})
