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
import schedule from '../jobs/schedule.js'

/* One deliberately vague message for every dead-invite failure mode: a more specific error
   ("expired" vs "already used" vs "no such invite") would tell an attacker probing skimmed
   tokens which ones are worth replaying. 410 Gone: the link itself is what's dead, distinct
   from a stale nonce (403) or a wrong password (401), so the frontend can tell them apart by
   status code alone. */
const invalidInviteError = () => new ApiError(httpStatus.GONE, 'Invite link is invalid or has expired')

/* The nonce (not the invite) is the problem: missing, wrong, expired, or replaced by a
   fresher page load. The frontend fetches a new one and retries once without the person
   noticing, rather than showing them the dead-link screen. */
const staleNonceError = () => new ApiError(httpStatus.FORBIDDEN, 'Invite link is invalid or has expired')

/* Long enough to set one password on a slow connection; short enough that a nonce
   skimmed alongside its token goes stale before it is useful. */
const NONCE_LIFETIME_MINUTES = 30

/* Long enough that a leaked old link can't flood the member's inbox, short enough that
   someone whose new link landed in spam can ask again in the same sitting. */
const PUBLIC_RESEND_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

/* Each public resend replaces the member's current link, so an old link someone kept
   must not work as a way to cancel it forever. */
const PUBLIC_RESEND_MAX_DAYS_SINCE_EXPIRY = 30

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
 * `password` serves two different roles depending on whether this email already has an
 * account: for a new one (or an existing passwordless shadow account — see
 * provisionInvitedMember), it's the password being set for the first time; for an account
 * that already has one, it's a login credential that must be verified — checked here,
 * before the invite is claimed, so a wrong password (401 'Incorrect password') leaves the
 * invite untouched rather than burning the person's one-time link for a failed login.
 *
 * After the token is consumed, provisions the account and writes the real-name identity if
 * the conversation uses real names. Issues auth tokens so the caller lands in the room
 * without a separate login step.
 *
 * If provisioning throws (e.g. a real-name clash with another member in the same room), the
 * claim is reverted so the person's one-time link still works once the underlying issue is
 * fixed.
 */
const consumeInvite = async (token: string, nonce: string, password: string) => {
  const { invite, membership } = await validateInvite(token)
  if (!nonce) {
    throw staleNonceError()
  }

  if (!(await userService.verifyExistingPassword(membership.email, password))) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect password')
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
    // validateInvite above already ruled out a dead invite (expired, consumed, invalidated,
    // or no matching record) — this is specifically a wrong/expired nonce, or two submits
    // racing for the same one, either way a 403 the frontend retries with a fresh nonce.
    throw staleNonceError()
  }

  const conversation = await Conversation.findById(membership.conversation).exec()
  let user
  try {
    user = await userService.provisionInvitedMember(membership, password, conversation)
  } catch (err) {
    await MemberInvite.updateOne({ _id: claimed._id }, { consumedAt: null })
    throw err
  }
  const tokens = await tokenService.generateAuthTokens(user)

  // Matches /auth/login's response shape (see auth.controller.ts) so the set-password page
  // can start a session the same way login does
  return { user, tokens, conversationId: membership.conversation.toString() }
}

/**
 * Everything the set-password screen needs from one GET: who the invite is for, which room
 * it opens, whether this is a first password set or a login (hasAccount), and the nonce the
 * eventual POST must echo back. Validates without consuming (see validateInvite for why).
 *
 * Deliberately drops the email: this endpoint takes only a token, so anyone with a
 * forwarded or leaked link can call it — the page only needs the name to greet the person
 * by, never their email address.
 */
const describeInvite = async (token: string) => {
  const { invite, membership } = await validateInvite(token)
  const conversation = await Conversation.findById(membership.conversation).exec()
  const nonce = await issueNonce(invite._id)
  const hasAccount = await userService.hasPasswordAccount(membership.email)
  return {
    nonce,
    member: { name: membership.name, hasAccount },
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

/* A throw would skip applySendResults and leave live links that nobody received, so the
   whole batch is recorded as failed before the error is passed on. */
const sendInviteBatchAndRecord = async (invites: Parameters<typeof emailService.sendMemberInviteBatch>[0]) => {
  let results
  try {
    results = await emailService.sendMemberInviteBatch(invites)
  } catch (err) {
    await applySendResults(invites.map(({ membershipId }) => ({ membershipId, success: false, error: 'send failed' })))
    throw err
  }
  await applySendResults(results)
  return results
}

const sendInvitesToPendingMembers = async (conversation, actingUser) => {
  const conversationId = conversation._id

  /* joined is excluded on top of inviteState: someone can join through Zoom or Slack
     before any invite goes out, and a live invite for a provisioned account is an
     account-takeover link. */
  const recipients = await ConversationMembership.find({
    conversation: conversationId,
    inviteState: { $in: ['pending', 'failed'] },
    joined: false,
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

  const results = await sendInviteBatchAndRecord(invites)

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

/* Two overlapping batch sends would each mint for the same members, the second killing the
   first's links, so every recipient gets two emails and one dead link. The rate limiter
   lets a double-click through, so the service refuses the overlap itself. In-process only,
   which matches the in-memory rate limiters this app already relies on. */
const sendsInFlight = new Set<string>()

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
  if (sendsInFlight.has(conversationId.toString())) {
    throw new ApiError(httpStatus.CONFLICT, 'Invites for this conversation are already being sent')
  }
  sendsInFlight.add(conversationId.toString())
  try {
    return await sendInvitesToPendingMembers(conversation, actingUser)
  } finally {
    sendsInFlight.delete(conversationId.toString())
  }
}

const mailFreshInvite = async (membership, conversation) => {
  const { token } = await mintInvite(membership)
  const [result] = await sendInviteBatchAndRecord([
    {
      membershipId: membership._id.toString(),
      to: membership.email,
      name: membership.name,
      roomName: conversation.name,
      token
    }
  ])
  return result
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

  const result = await mailFreshInvite(membership, conversation)
  logger.info(
    `invite.service: user ${actingUser._id} resent an invite for membership ${membershipId} ` +
      `(${result?.success ? 'sent' : 'failed'})`
  )
  return { sent: result?.success ? 1 : 0, failed: result?.success ? 0 : 1 }
}

/**
 * Find the invite behind a token that may be expired or superseded. Only the expiry check
 * is skipped: the signature and type checks still apply, so a dead link can ask for a new
 * one while a forged or repurposed token cannot. Returns null instead of throwing.
 */
const findInviteIgnoringExpiry = async (token: string) => {
  let payload: jwt.JwtPayload
  try {
    payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      ignoreExpiration: true
    }) as jwt.JwtPayload
  } catch {
    return null
  }
  if (payload.type !== tokenTypes.MEMBER_INVITE) {
    return null
  }
  if (!payload.exp || moment.unix(payload.exp).add(PUBLIC_RESEND_MAX_DAYS_SINCE_EXPIRY, 'days').isBefore(moment())) {
    return null
  }
  return MemberInvite.findOne({ tokenHash: sha256(token) }).exec()
}

/* A single conditional write, so two simultaneous requests can't both pass the cooldown. */
const claimPublicResendCooldown = (membershipId) =>
  ConversationMembership.findOneAndUpdate(
    {
      _id: membershipId,
      $or: [{ lastPublicResendAt: null }, { lastPublicResendAt: { $lte: new Date(Date.now() - PUBLIC_RESEND_COOLDOWN_MS) } }]
    },
    { lastPublicResendAt: new Date() }
  ).exec()

const skipPublicResend = (reason: string) => {
  logger.info(`invite.service: public invite resend skipped, ${reason}`)
}

/* Checked when the request arrives and again when the job runs, since an admin can remove
   the member or the member can sign up in between. */
const findResendableMembership = async (membershipId: string) => {
  const membership = await ConversationMembership.findById(membershipId).exec()
  if (!membership || membership.status !== 'active') {
    skipPublicResend(`membership ${membershipId} is missing or removed`)
    return null
  }
  /* userAccount is set when any of this member's invites is consumed, which catches a
     superseded link whose replacement was already used. */
  if (membership.joined || membership.userAccount) {
    skipPublicResend(`membership ${membershipId} already has an account`)
    return null
  }
  const conversation = await Conversation.findById(membership.conversation).exec()
  if (!conversation) {
    skipPublicResend(`conversation for membership ${membershipId} is missing`)
    return null
  }
  return { membership, conversation }
}

/* A send that failed on our side shouldn't make the member wait out the cooldown to ask again. */
const releasePublicResendCooldown = async (membershipId: string) => {
  await ConversationMembership.updateOne({ _id: membershipId }, { lastPublicResendAt: null }).exec()
}

const queuePublicResend = async (token: string) => {
  const invite = await findInviteIgnoringExpiry(token)
  if (!invite) {
    return skipPublicResend('token is not a genuine invite, or expired more than 30 days ago')
  }
  if (invite.consumedAt) {
    return skipPublicResend(`invite ${invite._id} was already used`)
  }
  const membershipId = invite.membership.toString()
  if (!(await findResendableMembership(membershipId))) {
    return undefined
  }
  if (!(await claimPublicResendCooldown(membershipId))) {
    return skipPublicResend(`membership ${membershipId} is inside the resend cooldown`)
  }
  try {
    await schedule.publicInviteResend({ membershipId, attempt: 1 })
  } catch (err) {
    await releasePublicResendCooldown(membershipId)
    throw err
  }
  logger.info(`invite.service: public invite resend queued for membership ${membershipId}`)
  return undefined
}

/**
 * Public "send me a new link" for a dead invite link: queues a fresh invite for the member's
 * address on file. The send runs in a job so the response never waits on Postmark (which would
 * make a real send noticeably slower than a skip) and so a Postmark outage can be retried. Never throws, because the caller
 * must answer every outcome identically.
 */
const resendInviteFromDeadLink = async (token: string) => {
  try {
    await queuePublicResend(token)
  } catch (err) {
    logger.error(`invite.service: public invite resend failed to queue: ${err?.name ?? 'unknown error'}`)
  }
}

/**
 * Job side of the public resend. Throws when the send itself throws, so the job can decide
 * whether to retry; the just-minted link is already cancelled by then (see
 * sendInviteBatchAndRecord).
 */
const deliverPublicResend = async (membershipId: string) => {
  const resendable = await findResendableMembership(membershipId)
  if (!resendable) {
    return
  }
  const result = await mailFreshInvite(resendable.membership, resendable.conversation)
  logger.info(`invite.service: public invite resend for membership ${membershipId} ${result?.success ? 'sent' : 'not sent'}`)
  return result
}

const inviteService = {
  mintInvite,
  validateInvite,
  issueNonce,
  consumeInvite,
  describeInvite,
  sendInvitesForConversation,
  resendInvite,
  resendInviteFromDeadLink,
  deliverPublicResend,
  releasePublicResendCooldown
}
export default inviteService
