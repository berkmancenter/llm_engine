import Joi from 'joi'

export interface SanitizedField {
  value: string
  error?: string
}

/* Control-character code points to strip: C0 (0-31) minus tab/LF/CR (handled separately by
   stripLineBreaks below), DEL (127), and C1 (128-159). Built from character codes rather
   than a regex literal with \u escapes, since none of these code points are regex
   metacharacters (all are well below the printable-ASCII range where ] \ - ^ live), so
   splicing them into a character class here is safe. */
const CONTROL_CHAR_CODES = [
  ...Array.from({ length: 32 }, (_, i) => i).filter((code) => ![9, 10, 13].includes(code)),
  127,
  ...Array.from({ length: 32 }, (_, i) => 128 + i)
]
// eslint-disable-next-line security/detect-non-literal-regexp -- built from a fixed, hardcoded code-point list above, not from any input
const CONTROL_CHARS_RE = new RegExp(`[${CONTROL_CHAR_CODES.map((code) => String.fromCharCode(code)).join('')}]`, 'g')

// Strips ASCII/Unicode control characters from a string. Safe for every field type —
// legitimate text never contains them — so it's applied unconditionally, unlike
// line-break stripping below which only applies to single-line fields.
const stripControlChars = (value: string): string => value.replace(CONTROL_CHARS_RE, '')

// Collapses line breaks (and other whitespace runs) to a single space — for fields that
// are meant to stay single-line: names, email, interests.
const stripLineBreaks = (value: string): string =>
  value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const emailSchema = Joi.string().trim().lowercase().email()

// name/interests: single-line free text.
export const sanitizeSingleLineText = (raw: string): SanitizedField => ({
  value: stripLineBreaks(stripControlChars(raw))
})

// bio: multi-line free text. Control characters are stripped but real line breaks (a
// legitimate paragraph break) are left alone, unlike the single-line fields above.
export const sanitizeMultiLineText = (raw: string): SanitizedField => ({
  value: stripControlChars(raw).trim()
})

// email: cleaned the same way as other single-line fields, then format-validated. This is
// the first place in this codebase to format-check an email with Joi's .email() — existing
// schemas for typed signup forms (user.validation.ts, auth.validation.ts) just use a bare
// Joi.string() — but a CSV uploaded by an admin is untrusted external data, unlike a typed
// form field, so the stricter check belongs here.
export const sanitizeEmail = (raw: string): SanitizedField => {
  const cleaned = stripLineBreaks(stripControlChars(raw))
  const { error } = emailSchema.validate(cleaned)
  if (error) {
    return { value: cleaned, error: 'must be a valid email address' }
  }
  return { value: cleaned.toLowerCase() }
}
