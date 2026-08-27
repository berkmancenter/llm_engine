/**
 * Thrown when Postmark refuses a recipient because a previous hard bounce or spam
 * complaint put the address on its suppression list. Not retryable: every later send to
 * the address fails the same way until the suppression is cleared in Postmark's
 * dashboard, so callers should surface the address rather than swallow the error.
 */
export default class SuppressedRecipientError extends Error {
  readonly recipient: string

  constructor(recipient: string) {
    // The address travels only on `recipient`, never in the message: callers log
    // err.message (see auth.service.ts), so putting it there would log it.
    super("Recipient is on Postmark's suppression list and cannot receive email")
    this.name = 'SuppressedRecipientError'
    this.recipient = recipient
  }
}
