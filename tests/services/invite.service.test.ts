import jwt from 'jsonwebtoken'
import moment from 'moment'
import httpStatus from 'http-status'
import setupIntTest from '../utils/setupIntTest.js'
import config from '../../src/config/config.js'
import tokenTypes from '../../src/config/tokens.js'
import inviteService from '../../src/services/invite.service.js'
import { ConversationMembership, MemberInvite } from '../../src/models/index.js'
import { insertConversations, conversationCommunityRoom } from '../fixtures/conversation.fixture.js'

setupIntTest()

const insertMembership = async (overrides = {}) =>
  ConversationMembership.create({
    conversation: conversationCommunityRoom._id,
    email: 'jane.doe@example.com',
    name: 'Jane Doe',
    bio: 'A bio',
    interests: 'Interests',
    ...overrides
  })

describe('invite service', () => {
  beforeEach(async () => {
    await insertConversations([conversationCommunityRoom])
  })

  describe('mintInvite', () => {
    test('returns a JWT and stores only a hash of it, never the raw token', async () => {
      const membership = await insertMembership()

      const { token, invite } = await inviteService.mintInvite(membership)

      const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload
      expect(payload.type).toBe(tokenTypes.MEMBER_INVITE)
      expect(payload.sub).toBe(membership._id.toString())

      const stored = await MemberInvite.findById(invite._id).lean()
      expect(stored).toBeTruthy()
      expect(stored!.tokenHash).toBeDefined()
      expect(stored!.tokenHash).not.toBe(token)
      expect(token).not.toContain(stored!.tokenHash)
      const anyRawField = JSON.stringify(stored)
      expect(anyRawField).not.toContain(token)
    })

    test('expiry is measured in days, not the handoff default of minutes', async () => {
      const membership = await insertMembership()

      const { token } = await inviteService.mintInvite(membership)

      const payload = jwt.verify(token, config.jwt.secret) as jwt.JwtPayload
      const lifetimeSeconds = payload.exp! - payload.iat!
      expect(lifetimeSeconds).toBe(config.jwt.inviteExpirationDays * 24 * 60 * 60)
      expect(lifetimeSeconds).toBeGreaterThan(24 * 60 * 60)
    })

    test('minting again invalidates every outstanding invite for the membership', async () => {
      const membership = await insertMembership()
      const first = await inviteService.mintInvite(membership)

      const second = await inviteService.mintInvite(membership)

      const firstStored = await MemberInvite.findById(first.invite._id).lean()
      expect(firstStored!.invalidatedAt).toBeTruthy()
      await expect(inviteService.validateInvite(first.token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
      await expect(inviteService.validateInvite(second.token)).resolves.toBeTruthy()
    })
  })

  describe('validateInvite', () => {
    test('accepts a freshly minted token and returns the invite and membership', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)

      const result = await inviteService.validateInvite(token)

      expect(result.membership._id.toString()).toBe(membership._id.toString())
      expect(result.invite.consumedAt).toBeFalsy()
    })

    test('does not consume: validating twice succeeds both times', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)

      await inviteService.validateInvite(token)
      await expect(inviteService.validateInvite(token)).resolves.toBeTruthy()
    })

    test('rejects a token of a different type signed with the same secret', async () => {
      const membership = await insertMembership()
      await inviteService.mintInvite(membership)
      const forged = jwt.sign(
        {
          sub: membership._id.toString(),
          type: tokenTypes.HANDOFF,
          iat: moment().unix(),
          exp: moment().add(1, 'day').unix()
        },
        config.jwt.secret,
        { algorithm: 'HS256' }
      )

      await expect(inviteService.validateInvite(forged)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('rejects a tampered token', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      const tampered = `${token.slice(0, -2)}xx`

      await expect(inviteService.validateInvite(tampered)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('rejects a well-formed token that has no invite record (revoked out of band)', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      await MemberInvite.deleteMany({ membership: membership._id })

      await expect(inviteService.validateInvite(token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('rejects an expired invite', async () => {
      const membership = await insertMembership()
      const { token, invite } = await inviteService.mintInvite(membership)
      await MemberInvite.updateOne({ _id: invite._id }, { expiresAt: moment().subtract(1, 'minute').toDate() })

      await expect(inviteService.validateInvite(token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('rejects when the membership has been removed', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      await ConversationMembership.updateOne({ _id: membership._id }, { status: 'removed' })

      await expect(inviteService.validateInvite(token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })
  })

  describe('issueNonce', () => {
    test('returns a raw nonce and stores only its hash', async () => {
      const membership = await insertMembership()
      const { invite } = await inviteService.mintInvite(membership)

      const nonce = await inviteService.issueNonce(invite._id)

      expect(typeof nonce).toBe('string')
      expect(nonce.length).toBeGreaterThanOrEqual(32)
      const stored = await MemberInvite.findById(invite._id).lean()
      expect(stored!.nonceHash).toBeTruthy()
      expect(stored!.nonceHash).not.toBe(nonce)
      expect(stored!.nonceExpiresAt).toBeTruthy()
    })

    test('issuing a new nonce replaces the old one', async () => {
      const membership = await insertMembership()
      const { token, invite } = await inviteService.mintInvite(membership)
      const oldNonce = await inviteService.issueNonce(invite._id)
      await inviteService.issueNonce(invite._id)

      await expect(inviteService.consumeInvite(token, oldNonce, 'Invite1234')).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })
  })

  describe('consumeInvite', () => {
    const password = 'Invite1234'

    test('consumes with token and nonce, creates account, returns auth tokens, exactly once', async () => {
      const membership = await insertMembership()
      const { token, invite } = await inviteService.mintInvite(membership)
      const nonce = await inviteService.issueNonce(invite._id)

      const result = await inviteService.consumeInvite(token, nonce, password)
      expect(result.membership._id.toString()).toBe(membership._id.toString())
      expect(result.tokens).toMatchObject({
        access: { token: expect.any(String), expires: expect.anything() },
        refresh: { token: expect.any(String), expires: expect.anything() }
      })
      expect(result.conversationId).toBe(membership.conversation.toString())

      const stored = await MemberInvite.findById(invite._id).lean()
      expect(stored!.consumedAt).toBeTruthy()

      await expect(inviteService.consumeInvite(token, nonce, password)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('a consumed token also fails plain validation afterwards', async () => {
      const membership = await insertMembership()
      const { token, invite } = await inviteService.mintInvite(membership)
      const nonce = await inviteService.issueNonce(invite._id)
      await inviteService.consumeInvite(token, nonce, password)

      await expect(inviteService.validateInvite(token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('rejects a valid token with a missing or wrong nonce, leaving the token unconsumed', async () => {
      const membership = await insertMembership()
      const { token, invite } = await inviteService.mintInvite(membership)
      await inviteService.issueNonce(invite._id)

      await expect(inviteService.consumeInvite(token, 'not-the-nonce', password)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
      await expect(inviteService.consumeInvite(token, '', password)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })

      const stored = await MemberInvite.findById(invite._id).lean()
      expect(stored!.consumedAt).toBeFalsy()
      await expect(inviteService.validateInvite(token)).resolves.toBeTruthy()
    })

    test('rejects a valid token whose nonce was never issued', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)

      await expect(inviteService.consumeInvite(token, 'anything', password)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })

    test('rejects an expired nonce', async () => {
      const membership = await insertMembership()
      const { token, invite } = await inviteService.mintInvite(membership)
      const nonce = await inviteService.issueNonce(invite._id)
      await MemberInvite.updateOne({ _id: invite._id }, { nonceExpiresAt: moment().subtract(1, 'minute').toDate() })

      await expect(inviteService.consumeInvite(token, nonce, password)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })
  })

  describe('scoping', () => {
    test('an invite for one membership cannot be consumed against another', async () => {
      const membershipA = await insertMembership()
      const membershipB = await insertMembership({ email: 'other@example.com', name: 'Other Person' })
      const inviteA = await inviteService.mintInvite(membershipA)
      const inviteB = await inviteService.mintInvite(membershipB)
      const nonceB = await inviteService.issueNonce(inviteB.invite._id)

      // Token A with B's nonce must not consume either record.
      await expect(inviteService.consumeInvite(inviteA.token, nonceB, 'Invite1234')).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
      const storedA = await MemberInvite.findById(inviteA.invite._id).lean()
      const storedB = await MemberInvite.findById(inviteB.invite._id).lean()
      expect(storedA!.consumedAt).toBeFalsy()
      expect(storedB!.consumedAt).toBeFalsy()
    })

    test('rejects a syntactically valid token whose membership no longer exists', async () => {
      const membership = await insertMembership()
      const { token } = await inviteService.mintInvite(membership)
      await ConversationMembership.deleteMany({ _id: membership._id })

      await expect(inviteService.validateInvite(token)).rejects.toMatchObject({
        statusCode: httpStatus.UNAUTHORIZED
      })
    })
  })
})
