import logger from '../../config/logger.js'
import inviteService from '../../services/invite.service.js'
import schedule from '../schedule.js'

/* About two and a half minutes in total: long enough to ride out a Postmark outage of a
   minute or two, short enough that the new link still arrives while the member is waiting. */
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000] // 30 seconds, then 2 minutes

/**
 * Mail the fresh invite a public resend request queued, retrying temporary Postmark failures.
 * Not idempotent: if the instance dies after Postmark accepts the message but before the job
 * finishes, the rerun mails a second link that replaces the first. The member still ends up
 * with one working link, and there is no stable key to prevent the second send.
 */
const publicInviteResend = async (job) => {
  const { membershipId, attempt = 1 } = job.attrs.data
  let result
  try {
    result = await inviteService.deliverPublicResend(membershipId)
  } catch (err) {
    // Name and code only: a mail provider's error message can quote the recipient's address.
    logger.error(
      `invite handler: public invite resend for membership ${membershipId} failed: ` +
        `${err?.name ?? 'unknown error'} (code ${err?.code ?? 'none'})`
    )
    await inviteService.releasePublicResendCooldown(membershipId)
    return
  }
  if (!result || result.success) {
    return
  }
  const retryDelayMs = RETRY_DELAYS_MS[attempt - 1]
  if (result.retryable && retryDelayMs !== undefined) {
    logger.warn(`invite handler: public invite resend for membership ${membershipId} failed on attempt ${attempt}, retrying`)
    await schedule.retryPublicInviteResend(new Date(Date.now() + retryDelayMs), { membershipId, attempt: attempt + 1 })
    return
  }
  logger.error(`invite handler: public invite resend for membership ${membershipId} gave up on attempt ${attempt}`)
  await inviteService.releasePublicResendCooldown(membershipId)
}

export default { publicInviteResend }
