import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import moment from 'moment'
import httpStatus from 'http-status'
import config from '../config/config.js'
import logger from '../config/logger.js'
import tokenTypes from '../config/tokens.js'
import ApiError from '../utils/ApiError.js'
import MemberInvite from '../models/memberInvite.model.js'
import ConversationMembership from '../models/conversationMembership.model.js'
import Conversation from '../models/conversation.model.js'
import emailService from './email.service.js'
import userService from './user.service.js'
import tokenService from './token.service.js'

/* One deliberately vague message for every failure mode: a more specific error
   ("expired" vs "already used" vs "no such invite") would tell an attacker probing
   skimmed tokens which ones are worth replaying. */
const invalidInviteError = () => new ApiError(httpStatus.UNAUTHORIZED, 'Invite link is invalid or has expired')

/* Long enough to set one password on a slow connection; short enough that a nonce
   skimmed alongside its token goes stale before it is useful. */
const NONCE_LIFETIME_MINUTES = 30

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Mint a fresh invite token for a membership, invalidating any outstanding one first so a
 * member only ever has one live link (admin resend must kill the link it replaces).
 * The raw JWT is returned for the email and never stored; the record keeps only its hash.
 */
const mintInvite = async (membership) => {
  await MemberInvite.updateMany(
    { membership: membership._id, consumedAt: null, invalidatedAt: null },
    { invalidatedAt: new Date() }
  )

  const expires = moment().add(config.jwt.inviteExpirationDays, 'days')
  const payload = {
    sub: membership._id.toString(),
    jti: randomUUID(),
    type: tokenTypes.MEMBER_INVITE,
    iat: moment().unix(),
    exp: expires.unix()
  }
  /* Pin to HS256 so the algorithm can't be negotiated from the token header. */
  const token = jwt.sign(payload, config.jwt.secret, { algorithm: 'HS256' })

  const invite = await MemberInvite.create({
    membership: membership._id,
    tokenHash: sha256(token),
    expiresAt: expires.toDate()
  })
  return { token, invite }
}

/**
 * Check a token without consuming it. Deliberate: mail scanners (Proofpoint URL Defense,
 * Safe Links) pre-open invite links with a GET before the person ever clicks, so the GET
 * path must be repeatable and only the set-password POST may burn the token.
 */
const validateInvite = async (token: string) => {
  let payload: jwt.JwtPayload
  try {
    /* Explicit algorithm allowlist: rejects anything other than HS256, including 'none'. */
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as jwt.JwtPayload
  } catch {
    throw invalidInviteError()
  }
  /* Type guard: an access, refresh, reset, or handoff token signed with the same secret
     must not work as an invite. */
  if (payload.type !== tokenTypes.MEMBER_INVITE) {
    throw invalidInviteError()
  }

  /* The JWT alone is replayable until expiry; the record is what makes it single-use and
     revocable. Look it up by hash so the collection never holds a usable token. */
  const invite = await MemberInvite.findOne({
    tokenHash: sha256(token),
    consumedAt: null,
    invalidatedAt: null,
    expiresAt: { $gt: new Date() }
  }).exec()
  if (!invite) {
    throw invalidInviteError()
  }

  const membership = await ConversationMembership.findOne({ _id: invite.membership, status: 'active' }).exec()
  if (!membership) {
    throw invalidInviteError()
  }

  return { invite, membership }
}

/**
 * Issue the one-time value the GET hands to the set-password screen and the POST must
 * echo back. With CORS open and no CSRF layer in the stack, this is what stops a token
 * skimmed from a log or scanner queue from completing the flow without ever rendering
 * the page. Re-issuing replaces the previous nonce, so the person's latest page load wins.
 */
const issueNonce = async (inviteId) => {
  const nonce = randomBytes(24).toString('hex')
  await MemberInvite.updateOne(
    { _id: inviteId },
    {
      nonceHash: sha256(nonce),
      nonceExpiresAt: moment().add(NONCE_LIFETIME_MINUTES, 'minutes').toDate()
    }
  ).exec()
  return nonce
}

/**
 * Burn the invite and provision the account: called from the set-password POST and nowhere
 * else. The single atomic claim (filtering on unconsumed + matching live nonce, setting
 * consumedAt) is what makes two concurrent submits resolve to exactly one winner.
 *
 * After the token is consumed, provisions the account (find-or-create by email) and writes
 * the real-name identity if the conversation uses real names. Issues auth tokens so the
 * caller lands in the room without a separate login step.
 */
const consumeInvite = async (token: string, nonce: string, password: string) => {
  const { invite, membership } = await validateInvite(token)
  if (!nonce) {
    throw invalidInviteError()
  }

  const claimed = await MemberInvite.findOneAndUpdate(
    {
      _id: invite._id,
      consumedAt: null,
      invalidatedAt: null,
      nonceHash: sha256(nonce),
      nonceExpiresAt: { $gt: new Date() }
    },
    { consumedAt: new Date() },
    { new: true }
  ).exec()
  if (!claimed) {
    throw invalidInviteError()
  }

  const conversation = await Conversation.findById(membership.conversation).exec()
  const user = await userService.provisionInvitedMember(membership, password, conversation)
  const tokens = await tokenService.generateAuthTokens(user)

  return { invite: claimed, membership, tokens, conversationId: membership.conversation.toString() }
}

/**
 * Everything the set-password screen needs from one GET: who the invite is for, which
 * room it opens, and the nonce the eventual POST must echo back. Validates without
 * consuming (see validateInvite for why).
 */
const describeInvite = async (token: string) => {
  const { invite, membership } = await validateInvite(token)
  const conversation = await Conversation.findById(membership.conversation).exec()
  const nonce = await issueNonce(invite._id)
  return {
    nonce,
    member: { name: membership.name, email: membership.email },
    conversation: conversation ? { id: conversation._id.toString(), name: conversation.name } : null
  }
}

/**
 * Apply the batch send's per-recipient results to the member records. A success becomes
 * 'invited'; a failure becomes 'failed' with the reason kept for the admin, and its
 * never-delivered token is invalidated so no live link exists that nobody received.
 */
const applySendResults = async (results: Array<{ membershipId: string; success: boolean; error?: string }>) => {
  await Promise.all(
    results.map(async (result) => {
      if (result.success) {
        await ConversationMembership.updateOne(
          { _id: result.membershipId },
          { inviteState: 'invited', inviteError: null }
        ).exec()
        return
      }
      await ConversationMembership.updateOne(
        { _id: result.membershipId },
        { inviteState: 'failed', inviteError: result.error ?? 'send failed' }
      ).exec()
      await MemberInvite.updateMany(
        { membership: result.membershipId, consumedAt: null, invalidatedAt: null },
        { invalidatedAt: new Date() }
      ).exec()
    })
  )
}

/**
 * Batch-send invites for a conversation: every 'pending' member (never mailed) and every
 * 'failed' one (mailed but never delivered). 'invited' members are excluded outright, so
 * re-running after an import can never re-mail anyone; that is the per-member resend's job.
 */
const sendInvitesForConversation = async (conversationId, actingUser) => {
  const conversation = await Conversation.findById(conversationId).exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }

  const recipients = await ConversationMembership.find({
    conversation: conversationId,
    inviteState: { $in: ['pending', 'failed'] },
    status: 'active'
  }).exec()

  if (!recipients.length) {
    return { sent: 0, failed: 0, failures: [] }
  }

  const invites: Array<{ membershipId: string; to: string; name: string; roomName: string; token: string }> = []
  for (const membership of recipients) {
    const { token } = await mintInvite(membership)
    invites.push({
      membershipId: membership._id.toString(),
      to: membership.email,
      name: membership.name,
      roomName: conversation.name,
      token
    })
  }

  const results = await emailService.sendMemberInviteBatch(invites)
  await applySendResults(results)

  const emailByMembershipId = new Map(invites.map((invite) => [invite.membershipId, invite.to]))
  const failures = results
    .filter((result) => !result.success)
    .map((result) => ({
      membershipId: result.membershipId,
      email: emailByMembershipId.get(result.membershipId),
      error: result.error ?? 'send failed'
    }))

  logger.info(
    `invite.service: user ${actingUser._id} sent invites for conversation ${conversationId}: ` +
      `${results.length - failures.length} sent, ${failures.length} failed`
  )

  return { sent: results.length - failures.length, failed: failures.length, failures }
}

/**
 * Re-invite one member: the outstanding link dies (mintInvite invalidates it) and a fresh
 * one is mailed, whatever the current inviteState. Refused once they have joined, because
 * a live invite for an already-provisioned account would be an account-takeover link.
 */
const resendInvite = async (membershipId, actingUser) => {
  const membership = await ConversationMembership.findOne({ _id: membershipId, status: 'active' }).exec()
  if (!membership) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Member not found')
  }
  if (membership.joined) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Member has already joined')
  }
  const conversation = await Conversation.findById(membership.conversation).exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  }

  const { token } = await mintInvite(membership)
  const results = await emailService.sendMemberInviteBatch([
    {
      membershipId: membership._id.toString(),
      to: membership.email,
      name: membership.name,
      roomName: conversation.name,
      token
    }
  ])
  await applySendResults(results)

  const [result] = results
  logger.info(
    `invite.service: user ${actingUser._id} resent an invite for membership ${membershipId} ` +
      `(${result?.success ? 'sent' : 'failed'})`
  )
  return { sent: result?.success ? 1 : 0, failed: result?.success ? 0 : 1 }
}

const inviteService = {
  mintInvite,
  validateInvite,
  issueNonce,
  consumeInvite,
  describeInvite,
  sendInvitesForConversation,
  resendInvite
}
export default inviteService
