import { jest } from '@jest/globals'
import request from 'supertest'
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import app from '../../src/app.js'
import { Conversation, OrganizerConfirmation, Topic } from '../../src/models/index.js'
import emailService from '../../src/services/email.service.js'
import organizerConfirmationService from '../../src/services/eventSetup/organizerConfirmation.service.js'
import { organizerConfirmationLimiter } from '../../src/middlewares/rateLimiter.js'
import { insertUsers } from '../fixtures/user.fixture.js'

setupIntTest()

const HOUR_MS = 60 * 60 * 1000

const newUser = (email: string) => ({
  _id: new mongoose.Types.ObjectId(),
  username: email.split('@')[0],
  email,
  password: 'password1',
  role: 'participant',
  isEmailVerified: false
})

const insertPendingConversation = async () => {
  const [owner] = await insertUsers([newUser(`org-${new mongoose.Types.ObjectId().toHexString()}@example.edu`)])
  const topic = await Topic.create({
    name: 'Confirmation Test Topic',
    owner: owner._id,
    votingAllowed: false,
    conversationCreationAllowed: true,
    private: false,
    archivable: true
  })
  const conversation = await Conversation.create({
    name: 'Pending Zoom Event',
    owner: owner._id,
    topic: topic._id,
    conversationType: 'eventAssistant',
    platforms: ['nextspace', 'zoom'],
    scheduledTime: new Date(Date.now() + 24 * HOUR_MS),
    scheduledEndTime: new Date(Date.now() + 25 * HOUR_MS),
    properties: { zoomMeetingUrl: 'https://zoom.us/j/123456789' },
    source: { pendingOrganizerConfirmation: true },
    draft: true
  })
  return { conversation, owner }
}

describe('organizer-confirmation endpoints', () => {
  beforeEach(async () => {
    jest.spyOn(emailService, 'sendEventCreatedEmail').mockResolvedValue(undefined as never)
    // Same shared-limiter reset dance as invites.test.ts, for every loopback key supertest
    // can resolve to.
    await Promise.all(['::1', '127.0.0.1', '::ffff:127.0.0.1'].map((key) => organizerConfirmationLimiter.resetKey(key)))
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('GET /v1/organizer-confirmation (public validate, no consume)', () => {
    test('returns the conversation summary and a nonce for a valid token', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      const res = await request(app).get('/v1/organizer-confirmation').query({ token }).expect(httpStatus.OK)

      expect(res.body.nonce).toEqual(expect.any(String))
      expect(res.body.conversation).toMatchObject({ id: conversation._id.toString(), name: 'Pending Zoom Event' })
      expect(res.headers['cache-control']).toContain('no-store')
      expect(res.headers['referrer-policy']).toBe('no-referrer')
    })

    test('does not consume: a scanner pre-open plus a real click both succeed', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      await request(app).get('/v1/organizer-confirmation').query({ token }).expect(httpStatus.OK)
      await request(app).get('/v1/organizer-confirmation').query({ token }).expect(httpStatus.OK)

      const confirmation = await OrganizerConfirmation.findOne({ conversation: conversation._id }).lean()
      expect(confirmation!.consumedAt).toBeFalsy()
    })

    test('returns 410 for an invalid token and 400 for a missing one', async () => {
      await request(app).get('/v1/organizer-confirmation').query({ token: 'garbage' }).expect(httpStatus.GONE)
      await request(app).get('/v1/organizer-confirmation').expect(httpStatus.BAD_REQUEST)
    })

    test('never leaks the token hash or nonce hash in the response', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      const res = await request(app).get('/v1/organizer-confirmation').query({ token }).expect(httpStatus.OK)

      const body = JSON.stringify(res.body)
      expect(body).not.toContain('tokenHash')
      expect(body).not.toContain('nonceHash')
    })
  })

  describe('POST /v1/organizer-confirmation/confirm (public confirm)', () => {
    const getNonce = async (token: string) => {
      const res = await request(app).get('/v1/organizer-confirmation').query({ token }).expect(httpStatus.OK)
      return res.body.nonce as string
    }

    test('confirms with token and nonce, activates the conversation, and is single-use', async () => {
      const { conversation, owner } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      const nonce = await getNonce(token)

      const res = await request(app).post('/v1/organizer-confirmation/confirm').send({ token, nonce }).expect(httpStatus.OK)

      expect(res.headers['cache-control']).toContain('no-store')
      expect(res.body).toMatchObject({ conversationId: conversation._id.toString(), draft: false })

      const persisted = await Conversation.findById(conversation._id)
      expect(persisted!.draft).toBe(false)
      expect(persisted!.source?.pendingOrganizerConfirmation).toBe(false)
      expect(emailService.sendEventCreatedEmail).toHaveBeenCalledWith(owner.email, expect.anything(), [])

      await request(app).post('/v1/organizer-confirmation/confirm').send({ token, nonce }).expect(httpStatus.GONE)
    })

    test('a skimmed token alone cannot confirm: the nonce is required', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      await getNonce(token)

      await request(app).post('/v1/organizer-confirmation/confirm').send({ token }).expect(httpStatus.BAD_REQUEST)
      await request(app)
        .post('/v1/organizer-confirmation/confirm')
        .send({ token, nonce: 'wrong' })
        .expect(httpStatus.FORBIDDEN)
    })
  })
})
