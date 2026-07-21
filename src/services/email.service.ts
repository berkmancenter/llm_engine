import nodemailer from 'nodemailer'
import config from '../config/config.js'
import logger from '../config/logger.js'

const transport = nodemailer.createTransport(config.email.smtp)
/* istanbul ignore next */
if (config.env !== 'test') {
  transport
    .verify()
    .then(() => logger.info('Connected to email server'))
    .catch(() => logger.warn('Unable to connect to email server. Make sure you have configured the SMTP options in .env'))
}
/**
 * Send an email
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @returns {Promise}
 */
const sendEmailAsync = async (to, subject, text, html) => {
  const msg = { from: config.email.from, to, subject, text, html }
  await transport.sendMail(msg)
}
/**
 * Send an email
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @returns {Promise}
 */
const sendEmail = (to, subject, text, html, callback) => {
  const msg = { from: config.email.from, to, subject, text, html }
  transport.sendMail(msg, callback)
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
  await sendEmailAsync(to, subject, text, html)
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
  sendEmail(to, subject, text, html, callback)
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
  await sendEmailAsync(to, subject, text, html)
}

/**
 * Invite an inbound-invite sender who has no account yet to sign up.
 * Only sent to senders inside an allowlisted domain (see emailSetup.service); an event is created
 * only once they have an account, so this is the reply that unblocks them.
 * @param {string} to
 * @returns {Promise}
 */
const sendSignupInviteEmail = async (to) => {
  const subject = 'Set up your Nextspace account to create your event'
  const signupUrl = `${config.appHost}/signup`
  const text = `Hello,
We received your calendar invite, but there's no Nextspace account for this email address yet.
To finish setting up your event, sign up here and then resend the invite: ${signupUrl}`
  const html = `<p>Hello,</p>
<p>We received your calendar invite, but there's no Nextspace account for this email address yet.</p>
<p>To finish setting up your event, <a href="${signupUrl}">sign up here</a> and then resend the invite.</p>`
  await sendEmailAsync(to, subject, text, html)
}

const emailService = {
  transport,
  sendEmail,
  sendEmailAsync,
  sendPasswordResetEmail,
  sendPasswordResetEmailAsync,
  sendArchiveTopicEmail,
  sendSignupInviteEmail
}
export default emailService
