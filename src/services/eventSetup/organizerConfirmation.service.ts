/*
 * The gate a relayed invite's resolved organizer must click through before the conversation
 * it created can ever leave Draft (see emailSetup.service.ts's resolveOrganizer and
 * lifecycle.ts's isConversationDraft). Zoom itself does not verify who sets the Reply-To shown
 * on its webinar emails, so a real inbox click is the one thing a forged Reply-To cannot
 * produce — see the module comment in emailSetup.service.ts for the full threat model.
 *
 * Deliberately mirrors invite.service.ts's MemberInvite flow (mint/validate/nonce/consume) since
 * it is the one existing token mechanism in this codebase that is single-use, DB-revocable, and
 * splits a safe/idempotent GET from a POST that actually burns the token — load-bearing here
 * too, since enterprise mail scanners (Proofpoint, Safe Links) pre-fetch emailed links with a
 * GET, and a GET that could confirm would let a scanner silently activate the event before the
 * organizer ever saw it. Skips everything invite.service.ts needs beyond that (password-setting,
 * batch sends, public resend) since this flow only ever has one pending confirmation per
 * conversation.
 */
import jwt from 'jsonwebtoken'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import moment from 'moment'
import httpStatus from 'http-status'
import config from '../../config/config.js'
import logger from '../../config/logger.js'
import tokenTypes from '../../config/tokens.js'
import ApiError from '../../utils/ApiError.js'
import { OrganizerConfirmation, Conversation, Adapter } from '../../models/index.js'
import { isConversationDraft } from '../conversation.service/lifecycle.js'
import scheduleConversationAutoStart from '../conversation.service/scheduleAutoStart.js'
import emailService from '../email.service.js'
import { getConversationType } from '../../conversations/index.js'
import missingRequirements from './missingRequirements.js'

/* One vague message for every dead-link failure mode, same reasoning as invite.service.ts's
   invalidInviteError: a more specific error would tell an attacker probing skimmed tokens which
   ones are worth replaying. */
const invalidConfirmationError = () => new ApiError(httpStatus.GONE, 'Confirmation link is invalid or has expired')

const staleNonceError = () => new ApiError(httpStatus.FORBIDDEN, 'Confirmation link is invalid or has expired')

/* Same lifetime as invite.service.ts's invite nonce: long enough to load a page and click
   confirm, short enough that a nonce skimmed alongside its token goes stale before it is useful. */
const NONCE_LIFETIME_MINUTES = 30

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Mint a confirmation token for a freshly-created, pending conversation. The raw JWT is
 * returned for the email and never stored; the record keeps only its hash.
 */
const mintConfirmation = async (conversation) => {
  const expires = moment.utc().add(config.jwt.organizerConfirmationExpirationHours, 'hours')
  const payload = {
    sub: conversation._id.toString(),
    jti: randomUUID(),
    type: tokenTypes.ORGANIZER_CONFIRMATION,
    iat: moment().unix(),
    exp: expires.unix()
  }
  /* Pin to HS256 so the algorithm can't be negotiated from the token header. */
  const token = jwt.sign(payload, config.jwt.secret, { algorithm: 'HS256' })

  await OrganizerConfirmation.create({
    conversation: conversation._id,
    tokenHash: sha256(token),
    expiresAt: expires.toDate()
  })
  return { token, expiresAt: expires.toDate() }
}

/**
 * Check a token without consuming it. Deliberate: mail scanners pre-open links with a GET
 * before the person ever clicks, so the GET path must be repeatable and only the confirm POST
 * may burn the token — see the module comment above.
 */
const validateConfirmation = async (token: string) => {
  let payload: jwt.JwtPayload
  try {
    /* Explicit algorithm allowlist: rejects anything other than HS256, including 'none'. */
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as jwt.JwtPayload
  } catch {
    throw invalidConfirmationError()
  }
  /* Type guard: an access, refresh, reset, invite, or handoff token signed with the same secret
     must not work as a confirmation. */
  if (payload.type !== tokenTypes.ORGANIZER_CONFIRMATION) {
    throw invalidConfirmationError()
  }

  /* The JWT alone is replayable until expiry; the record is what makes it single-use and
     revocable. Look it up by hash so the collection never holds a usable token. */
  const confirmation = await OrganizerConfirmation.findOne({
    tokenHash: sha256(token),
    consumedAt: null,
    invalidatedAt: null,
    expiresAt: { $gt: new Date() }
  }).exec()
  if (!confirmation) {
    throw invalidConfirmationError()
  }

  const conversation = await Conversation.findById(confirmation.conversation).exec()
  if (!conversation) {
    throw invalidConfirmationError()
  }

  return { confirmation, conversation }
}

/**
 * Issue the one-time value the GET hands to the confirm screen and the POST must echo back.
 * Same reasoning as invite.service.ts's issueNonce: with no CSRF layer, this is what stops a
 * token skimmed from a log or scanner queue from completing the flow without ever rendering the
 * page. Re-issuing replaces the previous nonce, so the organizer's latest page load wins.
 */
const issueNonce = async (confirmationId) => {
  const nonce = randomBytes(24).toString('hex')
  await OrganizerConfirmation.updateOne(
    { _id: confirmationId },
    {
      nonceHash: sha256(nonce),
      nonceExpiresAt: moment().add(NONCE_LIFETIME_MINUTES, 'minutes').toDate()
    }
  ).exec()
  return nonce
}

/**
 * Everything a confirm screen needs from one GET: which event this is for and the nonce the
 * eventual POST must echo back. Validates without consuming (see validateConfirmation for why).
 */
const describeConfirmation = async (token: string) => {
  const { confirmation, conversation } = await validateConfirmation(token)
  const nonce = await issueNonce(confirmation._id)
  return {
    nonce,
    conversation: { id: conversation._id.toString(), name: conversation.name, scheduledTime: conversation.scheduledTime }
  }
}

/**
 * Burn the confirmation and activate the conversation: called from the confirm POST and nowhere
 * else. The single atomic claim (filtering on unconsumed + matching live nonce, setting
 * consumedAt) is what makes two concurrent submits resolve to exactly one winner.
 *
 * Deliberately does not route through conversationService.updateConversation: that function's
 * ownership check expects a logged-in user, its active-conversation and draft-edit-lockout
 * guards exist to stop a human from editing a live or about-to-start event, and none of that
 * fits "clear exactly one pending flag". Instead this clears the flag directly, recomputes draft
 * the same way updateConversation does, and reschedules auto-start via
 * conversation.service/scheduleAutoStart.js (the same function conversation.service/index.ts
 * itself uses) — so confirming after the original auto-start lead time has already passed still
 * gets picked up, the same as a human finishing their own draft late already does today. See that
 * module's own comment for why it's a standalone leaf rather than importing it through
 * conversation.service/index.ts directly.
 */
const confirmOrganizer = async (token: string, nonce: string) => {
  const { confirmation, conversation } = await validateConfirmation(token)
  if (!nonce) {
    throw staleNonceError()
  }

  const claimed = await OrganizerConfirmation.findOneAndUpdate(
    {
      _id: confirmation._id,
      consumedAt: null,
      invalidatedAt: null,
      nonceHash: sha256(nonce),
      nonceExpiresAt: { $gt: new Date() }
    },
    { consumedAt: new Date() },
    { new: true }
  ).exec()
  if (!claimed) {
    // validateConfirmation above already ruled out a dead confirmation (expired, consumed,
    // invalidated, or no matching record) — this is specifically a wrong/expired nonce, or two
    // submits racing for the same one, either way a 403 the frontend retries with a fresh nonce.
    throw staleNonceError()
  }

  conversation.source = { ...conversation.source, pendingOrganizerConfirmation: false }
  conversation.markModified('source') // Mongoose won't detect changes inside a Mixed field without this
  await conversation.populate(['topic', 'owner'])
  conversation.draft = isConversationDraft(conversation)
  await conversation.save()

  if (!conversation.draft && conversation.scheduledTime) {
    await scheduleConversationAutoStart(conversation)
  }

  logger.info(`Email webhook: organizer confirmed Zoom-relayed event ${conversation._id}`)

  // Same "here's what's still missing" message every other invite-created event gets (see
  // createEventForOrganizer in emailSetup.service.ts) — confirming doesn't guarantee every other
  // field was already filled in.
  const conversationType = getConversationType('eventAssistant')
  const missing = missingRequirements(conversation, conversationType)
  await emailService.sendEventCreatedEmail((conversation.owner as { email?: string })?.email, conversation, missing)

  return conversation
}

/**
 * Delete a conversation whose organizer-confirmation link expired with no click, plus its
 * Adapter(s) and the confirmation record itself. Scoped to exactly what gets provisioned
 * immediately at creation (see createEventForOrganizer in emailSetup.service.ts) — these are
 * skeleton records that never had real activity (never started, never confirmed), unlike
 * conversationService.deleteConversation's broader cascade for a real, possibly-active event.
 */
const deleteExpiredConversation = async (confirmation) => {
  await Adapter.deleteMany({ conversation: confirmation.conversation })
  await Conversation.deleteOne({ _id: confirmation.conversation })
  await OrganizerConfirmation.deleteOne({ _id: confirmation._id })
}

/**
 * Sweep every organizer-confirmation that expired with no click, deleting the conversation it
 * gated and itself. Idempotent by construction (deleting an already-deleted document is a
 * no-op), so safe for two instances to run the same tick against (see jobs/CLAUDE.md).
 */
const expireUnconfirmedConversations = async () => {
  const expired = await OrganizerConfirmation.find({
    consumedAt: null,
    invalidatedAt: null,
    expiresAt: { $lt: new Date() }
  }).exec()

  for (const confirmation of expired) {
    try {
      await deleteExpiredConversation(confirmation)
    } catch (err) {
      logger.error(`Failed to expire unconfirmed conversation ${confirmation.conversation}`, err)
    }
  }
  if (expired.length > 0) {
    logger.info(`Expired ${expired.length} unconfirmed Zoom-relayed conversation(s)`)
  }
}

export default {
  mintConfirmation,
  validateConfirmation,
  issueNonce,
  describeConfirmation,
  confirmOrganizer,
  expireUnconfirmedConversations
}
