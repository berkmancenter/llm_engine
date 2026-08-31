import postmark from 'postmark'
import config from '../config/config.js'
import logger from '../config/logger.js'
import eventUrls from './eventUrls.service.js'
import SuppressedRecipientError from '../utils/SuppressedRecipientError.js'
import EmailSendError from '../utils/EmailSendError.js'

// POSTMARK_API_TEST makes Postmark validate each request without sending, so the test
// suite exercises the real client with no token configured. Outside tests a missing
// token must not fall back to it: sends would look successful and deliver nothing.
const serverToken = config.email.postmarkServerToken ?? (config.env === 'test' ? 'POSTMARK_API_TEST' : undefined)
/* istanbul ignore next */
if (config.env !== 'test' && !serverToken) {
  logger.warn('POSTMARK_SERVER_TOKEN is not set. Outgoing email will fail until it is configured in .env')
}
const client = new postmark.ServerClient(serverToken ?? 'POSTMARK_API_TEST')

/**
 * Send an email
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} html
 * @param {string} [tag] - Postmark tag naming the message type, for per-type delivery stats
 * @returns {Promise}
 * @throws {SuppressedRecipientError} when the address is on Postmark's suppression list
 */
const sendEmailAsync = async (to, subject, text, html, tag?: string) => {
  if (!serverToken) {
    throw new Error('Outgoing email is not configured: POSTMARK_SERVER_TOKEN is missing')
  }
  const msg: postmark.Message = {
    From: config.email.from,
    To: to,
    Subject: subject,
    TextBody: text,
    HtmlBody: html,
    MessageStream: 'outbound',
    // Tracking stays off on every message: link tracking rewrites each URL through
    // Postmark's redirector, and several messages carry passcodes or tokens in their
    // URLs. Nothing consumes the tracking data; the Tag covers delivery searchability.
    TrackOpens: false,
    TrackLinks: postmark.Models.LinkTrackingOptions.None,
    Tag: tag
  }
  try {
    return await client.sendEmail(msg)
  } catch (error) {
    if (error instanceof postmark.Errors.InactiveRecipientsError) {
      // No address in the log; recipient addresses stay out of app logs. To find who was
      // suppressed and why, open the Postmark server's outbound message stream: Activity
      // shows the blocked send, and the Suppressions tab lists the address with its
      // reason (hard bounce, spam complaint, or manual) and a reactivation control.
      logger.error(
        `Postmark suppression list blocked a send (tag: ${
          tag ?? 'none'
        }); the recipient gets nothing until the suppression is cleared`
      )
      throw new SuppressedRecipientError(to)
    }
    if (error instanceof postmark.Errors.PostmarkError) {
      // Codes only, same reasoning as EmailSendError: Postmark's raw message can echo
      // the address. Look the failure up in Postmark's Activity view by these codes.
      logger.error(
        `Postmark send failed (tag: ${tag ?? 'none'}): ${error.name}, code ${error.code}, status ${error.statusCode}`
      )
      throw new EmailSendError(to, error)
    }
    throw error
  }
}
/**
 * Send an email, reporting the outcome through a node-style callback
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} html
 * @param {Function} [callback] - (error, result)
 * @param {string} [tag] - Postmark tag naming the message type, for per-type delivery stats
 */
const sendEmail = (to, subject, text, html, callback, tag?: string) => {
  sendEmailAsync(to, subject, text, html, tag).then(
    (result) => callback?.(null, result),
    (error) => callback?.(error)
  )
}
/**
 * Send password reset email asynchronously
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
const sendPasswordResetEmailAsync = async (to, token) => {
  const subject = 'Reset password'
  const resetPasswordUrl = `${config.appHost}/reset-password?token=${token}`
  const text = `Dear user,
  To reset your password, copy and paste this link in your browser: ${resetPasswordUrl}
  If you did not request any password resets, please ignore this email.`
  const html = `<p>Dear user,</p>
  <p>To reset your password, please <a href="${resetPasswordUrl}">click here</a>.</p>
  <p>If you did not request any password resets, please ignore this email.</p>`
  await sendEmailAsync(to, subject, text, html, 'password-reset')
}
/**
 * Send password reset email synchronously
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
const sendPasswordResetEmail = (to, token, callback) => {
  const subject = 'Reset password'
  const resetPasswordUrl = `${config.appHost}/reset-password?token=${token}`
  const text = `Dear user,
  To reset your password, copy and paste this link in your browser: ${resetPasswordUrl}
  If you did not request any password resets, please ignore this email.`
  const html = `<p>Dear user,</p>
  <p>To reset your password, please <a href="${resetPasswordUrl}">click here</a>.</p>
  <p>If you did not request any password resets, please ignore this email.</p>`
  sendEmail(to, subject, text, html, callback, 'password-reset')
}
/**
 * Send verification email
 * @param {string} to
 * @param {string} token
 * @returns {Promise}
 */
// const sendVerificationEmail = async (to, token) => {
//   const subject = 'Email Verification';
//   // replace this url with the link to the email verification page of your front-end app
//   const verificationEmailUrl = `${config.appHost}/verify-email?token=${token}`;
//   const text = `Dear user,
// To verify your email, click on this link: ${verificationEmailUrl}
// If you did not create an account, then ignore this email.`;
//   await sendEmailAsync(to, subject, text);
// };
/**
 * Send email to user for channel archiving
 * @param {string} to
 * @param {Topic} topic
 * @param {string} token
 * @returns {Promise}
 */
const sendArchiveTopicEmail = async (to, topic, token) => {
  const subject = 'Archiving Your Channel'
  // replace this url with the link to the archive topic page of your front-end app
  const archivalUrl = `${config.appHost}/archive-topic?topicId=${topic._id}&token=${token}`
  const text = `Dear Conversations user,
Your channel "${topic.name}" is now 90 days old, and will be archived and removed from Conversations in 7 days.
To prevent archival and keep your channel on Conversations, please copy and paste this link in your browser: ${archivalUrl}`
  const html = `<p>Dear user,</p>
<p>Your channel "${topic.name}" is now 90 days old, and will be archived and removed from Conversations in 7 days.</p>
<p>To prevent archival and keep your channel on Conversations, please <a href="${archivalUrl}">click here</a>.</p>`
  await sendEmailAsync(to, subject, text, html, 'archive-topic')
}

/**
 * Invite the sender of an inbound invite or plain email who has no account yet to sign up.
 * Only sent to senders inside an allowlisted domain (see emailSetup.service); an event is created
 * only once they have an account, so this is the reply that unblocks them.
 * @param {string} to
 * @returns {Promise}
 */
const sendSignupInviteEmail = async (to) => {
  const subject = 'Set up your account to create your event'
  const signupUrl = `${config.appHost}/signup`
  const text = `Hello,
We received your email, but there's no account for this email address yet.
To finish setting up your event, sign up here and then send your email again: ${signupUrl}`
  const html = `<p>Hello,</p>
<p>We received your email, but there's no account for this email address yet.</p>
<p>To finish setting up your event, <a href="${signupUrl}">sign up here</a> and then send your email again.</p>`
  await sendEmailAsync(to, subject, text, html, 'signup-invite')
}

/**
 * Notify an organizer that their inbound calendar invite became an event. When `missing` names
 * anything (e.g. a Zoom link, a series), the event was created as a draft that can't actually run
 * yet: the subject calls that out directly rather than saying "ready" and burying the caveat,
 * since a reviewer flagged that an organizer skimming "Your event is ready" could miss a required
 * follow-up until it's too late to fix before the event starts.
 * @param {string} to
 * @param {Conversation} conversation
 * @param {string[]} [missing]
 * @returns {Promise}
 */
const sendEventCreatedEmail = async (to, conversation, missing: string[] = []) => {
  const eventUrl = eventUrls.eventPageUrl(conversation)

  if (missing.length > 0) {
    const subject = 'Action needed: your event is missing required details'
    const missingList = missing.join(', ')
    const text = `Hello,
We turned your calendar invite into an event, but it still needs ${missingList} before it can run. Please add that here: ${eventUrl}
That page is also where you can edit any other details and find the moderator and participant links to share.`
    const html = `<p>Hello,</p>
<p>We turned your calendar invite into an event, but it still needs <strong>${missingList}</strong> before it can run. Please <a href="${eventUrl}">add that here</a>.</p>
<p>That page is also where you can edit any other details and find the moderator and participant links to share.</p>`
    await sendEmailAsync(to, subject, text, html, 'event-created')
    return
  }

  const subject = 'Your event is ready'
  const text = `Hello,
We turned your calendar invite into an event. Please confirm the event details are correct: ${eventUrl}
That page is also where you can edit any details and find the moderator and participant links to share.`
  const html = `<p>Hello,</p>
<p>We turned your calendar invite into an event. Please <a href="${eventUrl}">confirm the event details are correct</a>.</p>
<p>That page is also where you can edit any details and find the moderator and participant links to share.</p>`
  await sendEmailAsync(to, subject, text, html, 'event-created')
}

/**
 * Notify an organizer that we couldn't turn their inbound calendar invite into an event.
 * Deliberately excludes any error detail: the inbound address accepts mail from anyone, so the
 * reply body is not a safe place for stack traces or other internals. The full error goes to the
 * server log instead, keyed by the same referenceId so a report from the organizer is easy to
 * trace back.
 * @param {string} to
 * @param {string} [referenceId]
 * @returns {Promise}
 */
const sendEventCreationFailedEmail = async (to, referenceId?: string) => {
  const subject = "We couldn't create your event"
  const referenceLine = referenceId ? `\nReference: ${referenceId}` : ''
  const referenceHtml = referenceId ? `<p>Reference: ${referenceId}</p>` : ''
  const text = `Hello,
We received your calendar invite, but ran into a problem creating your event. Please try again, or reach out to support if this keeps happening.${referenceLine}`
  const html = `<p>Hello,</p>
<p>We received your calendar invite, but ran into a problem creating your event. Please try again, or reach out to support if this keeps happening.</p>${referenceHtml}`
  await sendEmailAsync(to, subject, text, html, 'event-creation-failed')
}

/**
 * Notify an organizer that their emailed Zoom link turned into an on-demand event. Leads with the
 * moderator and participant links, since those are the ones that open straight into the room
 * without signing in (unlike the event page link, which requires an account); the event page
 * link comes last as the place to edit the event or find these links again.
 * @param {string} to
 * @param {Object} urls - { eventPageUrl, moderatorUrl?, participantUrl } from eventUrls.service
 * @param {Object} [options]
 * @param {Date} [options.joinAt] - when the email describes a scheduled join rather than an immediate one
 * @returns {Promise}
 */
const sendOnDemandEventEmail = async (to, urls, { joinAt }: { joinAt?: Date } = {}) => {
  const botName = config.conversationBotName
  const subject = joinAt ? `${botName} will join your Zoom meeting` : `${botName} is joining your Zoom meeting`
  const whenLine = joinAt
    ? `${botName} will join your Zoom meeting at ${joinAt.toISOString()}.`
    : `${botName} is joining your Zoom meeting now.`

  const moderatorLine = urls.moderatorUrl ? `Moderator link (keep this one private): ${urls.moderatorUrl}\n` : ''
  const moderatorHtml = urls.moderatorUrl
    ? `<p>Moderator link (keep this one private): <a href="${urls.moderatorUrl}">${urls.moderatorUrl}</a></p>`
    : ''

  const text = `Hello,
${whenLine}
${moderatorLine}Participant link (share with anyone joining): ${urls.participantUrl}
Edit the event, or find these links again: ${urls.eventPageUrl}`
  const html = `<p>Hello,</p>
<p>${whenLine}</p>
${moderatorHtml}
<p>Participant link (share with anyone joining): <a href="${urls.participantUrl}">${urls.participantUrl}</a></p>
<p>Edit the event, or find these links again: <a href="${urls.eventPageUrl}">${urls.eventPageUrl}</a></p>`
  await sendEmailAsync(to, subject, text, html, 'on-demand-event')
}

/**
 * Notify an organizer that their emailed Zoom link could not become an event. Deliberately
 * excludes any error detail, same reasoning as sendEventCreationFailedEmail: the inbound address
 * accepts mail from anyone.
 * @param {string} to
 * @param {'noZoomLink' | 'invalidZoomLink'} reason
 * @returns {Promise}
 */
const sendOnDemandEventFailedEmail = async (to, reason: 'noZoomLink' | 'invalidZoomLink') => {
  const subject = "We couldn't join your Zoom meeting"
  const reasonLine =
    reason === 'noZoomLink'
      ? "we couldn't find a Zoom link in your email."
      : "the Zoom link in your email didn't look valid."
  const text = `Hello,
We received your email, but ${reasonLine} Please send it again with a Zoom meeting link included.`
  const html = `<p>Hello,</p>
<p>We received your email, but ${reasonLine} Please send it again with a Zoom meeting link included.</p>`
  await sendEmailAsync(to, subject, text, html, 'on-demand-event-failed')
}

/* CSV sanitization strips control characters but deliberately leaves markup-looking text
   alone (a bio may legitimately mention "<div>"), so anything CSV-sourced must be escaped
   at the point it enters an HTML body. */
const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * Build the member-invite message for one recipient. Pure builder, separated from the
 * transport so the copy stays reviewable and testable while the batch send itself waits
 * on outbound email moving to Postmark's API.
 *
 * The token rides in the query string, never the URL fragment. Enterprise email security
 * gateways (e.g. Proofpoint) rewrite every link in an incoming message to route it through
 * a scanning proxy before the recipient's browser ever sees it. Because those rewriters
 * encode the whole URL — including any fragment — putting the token in the fragment buys
 * nothing while its costs remain (hard JS dependency, no server-side error rendering).
 * Additionally, the GET validate endpoint does not consume the token, so a scanner that
 * pre-fetches the link to check it cannot use the token on the recipient's behalf.
 * @param {string} name
 * @param {string} roomName
 * @param {string} token
 * @returns {{subject: string, text: string, html: string}}
 */
const buildMemberInviteEmail = (name: string, roomName: string, token: string) => {
  const inviteUrl = `${config.appHost}${config.invitePath}?token=${token}`
  const expiryDays = config.jwt.inviteExpirationDays
  const subject = `You're invited to join ${roomName}`
  const text = `Hello ${name},
You've been invited to join ${roomName}. To accept, open this link, choose a password, and you'll land right in the room: ${inviteUrl}
This link is just for you, so please don't forward it. It expires in ${expiryDays} days; if it has expired, reply to this email and we'll send a fresh one.`
  const html = `<p>Hello ${escapeHtml(name)},</p>
<p>You've been invited to join ${escapeHtml(
    roomName
  )}. To accept, <a href="${inviteUrl}">open this link</a>, choose a password, and you'll land right in the room.</p>
<p>If the link doesn't open, copy and paste this address into your browser: ${inviteUrl}</p>
<p>This link is just for you, so please don't forward it. It expires in ${expiryDays} days; if it has expired, reply to this email and we'll send a fresh one.</p>`
  return { subject, text, html }
}

/**
 * Send invite emails in bulk with per-recipient results via Postmark's batch API.
 *
 * Tracking is off: Postmark link tracking rewrites the token URL through its own redirector,
 * which stacks on top of any enterprise gateway rewrite the recipient's mail system applies.
 * Two layers of rewriting increase the chance of breakage with no benefit for a one-time link.
 * @param {Array<{membershipId: string, to: string, name: string, roomName: string, token: string}>} invites
 * @returns {Promise<Array<{membershipId: string, success: boolean, error?: string}>>}
 */
const sendMemberInviteBatch = async (
  invites: Array<{ membershipId: string; to: string; name: string; roomName: string; token: string }>
): Promise<Array<{ membershipId: string; success: boolean; error?: string }>> => {
  const messages: postmark.Message[] = invites.map(({ to, name, roomName, token }) => {
    const { subject, text, html } = buildMemberInviteEmail(name, roomName, token)
    return {
      From: config.email.from,
      To: to,
      Subject: subject,
      TextBody: text,
      HtmlBody: html,
      MessageStream: 'outbound',
      TrackOpens: false,
      TrackLinks: postmark.Models.LinkTrackingOptions.None,
      Tag: 'member-invite'
    }
  })

  const results = await client.sendEmailBatch(messages)

  return invites.map(({ membershipId }, i) => ({
    membershipId,
    success: results[i].ErrorCode === 0,
    ...(results[i].ErrorCode !== 0 ? { error: results[i].Message } : {})
  }))
}

const emailService = {
  client,
  sendEmail,
  sendEmailAsync,
  sendPasswordResetEmail,
  sendPasswordResetEmailAsync,
  sendArchiveTopicEmail,
  sendSignupInviteEmail,
  sendEventCreatedEmail,
  sendEventCreationFailedEmail,
  sendOnDemandEventEmail,
  sendOnDemandEventFailedEmail,
  buildMemberInviteEmail,
  sendMemberInviteBatch
}
export default emailService
