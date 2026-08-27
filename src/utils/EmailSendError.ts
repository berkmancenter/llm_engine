import postmark from 'postmark'

/**
 * Any Postmark send failure other than a suppressed recipient. Carries only error codes:
 * Postmark's own text can echo the recipient address (a 422 rejecting a malformed To
 * field quotes it), and callers log err.message, so the raw text must stay out. The
 * address travels only on `recipient`.
 *
 * The original error is deliberately not attached as `cause`. logger.ts expands `cause`
 * into the logged string and Sentry's linkedErrors integration chains on it, so keeping
 * it would put Postmark's text (and the address) straight back into the logs. Look the
 * failure up in Postmark's Activity view by the codes below.
 */
export default class EmailSendError extends Error {
  readonly recipient: string

  readonly code: number

  readonly statusCode: number

  constructor(recipient: string, postmarkError: postmark.Errors.PostmarkError) {
    super(
      `Postmark rejected the send (${postmarkError.name}, code ${postmarkError.code}, status ${postmarkError.statusCode})`
    )
    this.name = 'EmailSendError'
    this.recipient = recipient
    this.code = postmarkError.code
    this.statusCode = postmarkError.statusCode
  }
}
