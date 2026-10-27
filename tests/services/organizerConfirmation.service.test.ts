import { jest } from '@jest/globals'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import moment from 'moment'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import config from '../../src/config/config.js'
import tokenTypes from '../../src/config/tokens.js'
import emailService from '../../src/services/email.service.js'
import organizerConfirmationService from '../../src/services/eventSetup/organizerConfirmation.service.js'
import { OrganizerConfirmation, Conversation, Adapter, Topic } from '../../src/models/index.js'
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

const insertPendingConversation = async (overrides: Record<string, unknown> = {}) => {
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
    source: { inviteUid: 'UID-CONFIRM-TEST', pendingOrganizerConfirmation: true },
    draft: true,
    ...overrides
  })
  return { conversation, owner }
}

describe('organizerConfirmation.service', () => {
  let sendEventCreatedSpy

  beforeEach(() => {
    sendEventCreatedSpy = jest.spyOn(emailService, 'sendEventCreatedEmail').mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('mintConfirmation', () => {
    it('returns a JWT and stores only a hash of it, never the raw token', async () => {
      const { conversation } = await insertPendingConversation()

      const { token, expiresAt } = await organizerConfirmationService.mintConfirmation(conversation)

      const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload
      expect(payload.type).toBe(tokenTypes.ORGANIZER_CONFIRMATION)
      expect(payload.sub).toBe(conversation._id.toString())

      const stored = await OrganizerConfirmation.findOne({ conversation: conversation._id }).lean()
      expect(stored).toBeTruthy()
      expect(stored!.tokenHash).toBeDefined()
      expect(stored!.tokenHash).not.toBe(token)
      expect(JSON.stringify(stored)).not.toContain(token)
      expect(stored!.expiresAt.getTime()).toBe(expiresAt.getTime())
    })

    it("expiry is measured in hours per config, not invite.service.ts's days default", async () => {
      const { conversation } = await insertPendingConversation()

      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload
      const lifetimeSeconds = payload.exp! - payload.iat!
      expect(lifetimeSeconds).toBe(config.jwt.organizerConfirmationExpirationHours * 60 * 60)
    })
  })

  describe('validateConfirmation', () => {
    it('accepts a freshly minted token and returns the confirmation and conversation', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      const result = await organizerConfirmationService.validateConfirmation(token)

      expect(result.conversation._id.toString()).toBe(conversation._id.toString())
      expect(result.confirmation.consumedAt).toBeFalsy()
    })

    it('does not consume: validating twice succeeds both times', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      await organizerConfirmationService.validateConfirmation(token)
      await expect(organizerConfirmationService.validateConfirmation(token)).resolves.toBeTruthy()
    })

    it('rejects a token of a different type signed with the same secret', async () => {
      const { conversation } = await insertPendingConversation()
      const forged = jwt.sign(
        {
          sub: conversation._id.toString(),
          type: tokenTypes.MEMBER_INVITE,
          iat: moment().unix(),
          exp: moment().add(1, 'hour').unix()
        },
        config.jwt.secret,
        { algorithm: 'HS256' }
      )

      await expect(organizerConfirmationService.validateConfirmation(forged)).rejects.toMatchObject({
        statusCode: httpStatus.GONE
      })
    })

    it('rejects a tampered token', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      await expect(organizerConfirmationService.validateConfirmation(`${token}tampered`)).rejects.toMatchObject({
        statusCode: httpStatus.GONE
      })
    })

    it('rejects an expired confirmation', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      await OrganizerConfirmation.updateOne({ conversation: conversation._id }, { expiresAt: new Date(Date.now() - 1000) })

      await expect(organizerConfirmationService.validateConfirmation(token)).rejects.toMatchObject({
        statusCode: httpStatus.GONE
      })
    })

    it('rejects when the conversation has been removed', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      await Conversation.deleteOne({ _id: conversation._id })

      await expect(organizerConfirmationService.validateConfirmation(token)).rejects.toMatchObject({
        statusCode: httpStatus.GONE
      })
    })
  })

  describe('issueNonce / describeConfirmation', () => {
    it('returns a raw nonce and stores only its hash', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      const result = await organizerConfirmationService.describeConfirmation(token)

      expect(result.nonce).toBeDefined()
      expect(result.conversation.id).toBe(conversation._id.toString())
      const stored = await OrganizerConfirmation.findOne({ conversation: conversation._id }).lean()
      expect(stored!.nonceHash).toBeDefined()
      expect(stored!.nonceHash).not.toBe(result.nonce)
    })

    it('issuing a new nonce replaces the old one', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      const first = await organizerConfirmationService.describeConfirmation(token)
      const second = await organizerConfirmationService.describeConfirmation(token)

      expect(second.nonce).not.toBe(first.nonce)
      await expect(organizerConfirmationService.confirmOrganizer(token, first.nonce)).rejects.toMatchObject({
        statusCode: httpStatus.FORBIDDEN
      })
    })
  })

  describe('confirmOrganizer', () => {
    it('clears the pending flag, recomputes draft, and sends the normal event-created email exactly once', async () => {
      const { conversation, owner } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      const { nonce } = await organizerConfirmationService.describeConfirmation(token)

      const confirmed = await organizerConfirmationService.confirmOrganizer(token, nonce)

      expect(confirmed.source?.pendingOrganizerConfirmation).toBe(false)
      expect(confirmed.draft).toBe(false)
      expect(sendEventCreatedSpy).toHaveBeenCalledTimes(1)
      expect(sendEventCreatedSpy).toHaveBeenCalledWith(owner.email, expect.anything(), [])

      const persisted = await Conversation.findById(conversation._id)
      expect(persisted!.draft).toBe(false)
    })

    it('is single-use: consuming twice fails the second time', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      const { nonce } = await organizerConfirmationService.describeConfirmation(token)

      await organizerConfirmationService.confirmOrganizer(token, nonce)

      await expect(organizerConfirmationService.confirmOrganizer(token, nonce)).rejects.toMatchObject({
        statusCode: httpStatus.GONE
      })
    })

    it('rejects a missing or wrong nonce, leaving the token unconsumed', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      await organizerConfirmationService.describeConfirmation(token)

      await expect(organizerConfirmationService.confirmOrganizer(token, '')).rejects.toMatchObject({
        statusCode: httpStatus.FORBIDDEN
      })
      await expect(organizerConfirmationService.confirmOrganizer(token, 'wrong-nonce')).rejects.toMatchObject({
        statusCode: httpStatus.FORBIDDEN
      })

      // Still usable with the right nonce afterwards.
      const { nonce } = await organizerConfirmationService.describeConfirmation(token)
      await expect(organizerConfirmationService.confirmOrganizer(token, nonce)).resolves.toBeTruthy()
    })

    it('rejects a nonce that was never issued for this token', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)

      await expect(organizerConfirmationService.confirmOrganizer(token, 'never-issued')).rejects.toMatchObject({
        statusCode: httpStatus.FORBIDDEN
      })
    })

    it('still activates a conversation confirmed after its original auto-start lead time passed', async () => {
      // A scheduledTime already within the auto-start lead window: confirming "late" must still
      // schedule a start rather than silently never running.
      const { conversation } = await insertPendingConversation({
        scheduledTime: new Date(Date.now() + 60 * 1000),
        scheduledEndTime: new Date(Date.now() + HOUR_MS)
      })
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      const { nonce } = await organizerConfirmationService.describeConfirmation(token)

      const confirmed = await organizerConfirmationService.confirmOrganizer(token, nonce)

      expect(confirmed.draft).toBe(false)
    })
  })

  describe('expireUnconfirmedConversations', () => {
    it('deletes the conversation, its adapters, and the confirmation once expired with no click', async () => {
      const { conversation } = await insertPendingConversation()
      await Adapter.create({
        type: 'zoom',
        config: { meetingUrl: 'https://zoom.us/j/123456789' },
        conversation: conversation._id,
        active: true
      })
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      await OrganizerConfirmation.updateOne({ conversation: conversation._id }, { expiresAt: new Date(Date.now() - 1000) })

      await organizerConfirmationService.expireUnconfirmedConversations()

      expect(await Conversation.findById(conversation._id)).toBeNull()
      expect(await Adapter.findOne({ conversation: conversation._id })).toBeNull()
      expect(await OrganizerConfirmation.findOne({ conversation: conversation._id })).toBeNull()
      // The token is gone along with its record either way, but double check it's unusable.
      await expect(organizerConfirmationService.validateConfirmation(token)).rejects.toMatchObject({
        statusCode: httpStatus.GONE
      })
    })

    it('leaves a confirmed conversation alone even past its expiresAt', async () => {
      const { conversation } = await insertPendingConversation()
      const { token } = await organizerConfirmationService.mintConfirmation(conversation)
      const { nonce } = await organizerConfirmationService.describeConfirmation(token)
      await organizerConfirmationService.confirmOrganizer(token, nonce)
      await OrganizerConfirmation.updateOne({ conversation: conversation._id }, { expiresAt: new Date(Date.now() - 1000) })

      await organizerConfirmationService.expireUnconfirmedConversations()

      expect(await Conversation.findById(conversation._id)).not.toBeNull()
    })

    it('leaves an unexpired pending conversation alone', async () => {
      const { conversation } = await insertPendingConversation()
      await organizerConfirmationService.mintConfirmation(conversation)

      await organizerConfirmationService.expireUnconfirmedConversations()

      expect(await Conversation.findById(conversation._id)).not.toBeNull()
    })
  })
})
