import httpStatus from 'http-status'
import crypto from 'crypto'
import { Buffer } from 'buffer'
import ICAL from 'ical.js'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import logger from '../config/logger.js'
import { createConversationFromInvite, createConversationFromEmail } from '../services/eventSetup/emailSetup.service.js'
import { ParsedInvite } from '../types/index.types.js'

/** A single entry from an inbound email webhook's `Attachments` array (Postmark's shape, for example). */
interface InboundEmailAttachment {
  Name?: string
  Content?: string // base64-encoded file bytes
  ContentType?: string
  ContentLength?: number
  ContentID?: string
}

/**
 * A calendar invite arrives either with a `text/calendar` content type or, when a mail relay
 * rewrites it to something generic, only as a `.ics` filename. Match on either.
 */
const isCalendarAttachment = (attachment: InboundEmailAttachment): boolean => {
  const contentType = (attachment?.ContentType ?? '').toLowerCase()
  const name = (attachment?.Name ?? '').toLowerCase()
  return contentType.startsWith('text/calendar') || contentType.includes('application/ics') || name.endsWith('.ics')
}

/** ORGANIZER values look like `mailto:jane@example.com`; return just the address. */
const organizerEmail = (organizer: string | null): string | undefined =>
  organizer ? organizer.replace(/^mailto:/i, '') : undefined

/**
 * Pull the calendar fields out of an inbound email webhook payload's base64 `.ics` attachment.
 * Returns null when the message has no calendar attachment or no event component. Reads only
 * the fields the .ics states outright; nothing here interprets the free-text body.
 */
export const parseInviteFromPayload = (payload: {
  Attachments?: InboundEmailAttachment[]
  [key: string]: unknown
}): ParsedInvite | null => {
  const attachment = (payload?.Attachments ?? []).find(isCalendarAttachment)
  if (!attachment?.Content) return null

  const icsBody = Buffer.from(attachment.Content, 'base64').toString('utf8')
  const calendar = new ICAL.Component(ICAL.parse(icsBody))

  const vevent = calendar.getFirstSubcomponent('vevent')
  if (!vevent) return null
  const event = new ICAL.Event(vevent)

  return {
    uid: event.uid ?? undefined,
    summary: event.summary ?? undefined,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    startDate: event.startDate?.toJSDate(),
    endDate: event.endDate?.toJSDate(),
    organizer: organizerEmail(event.organizer)
  }
}

/** Compare in constant time so response timing can't leak the secret a byte at a time. */
const credentialsMatch = (provided: string, expected: string): boolean => {
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length) return false
  return crypto.timingSafeEqual(new Uint8Array(providedBuffer), new Uint8Array(expectedBuffer))
}

const handleEvent = async (req, res) => {
  // Inbound email webhook providers retry a non-200 response (Postmark: 10 times over ~10.5
  // hours), so acknowledge before parsing.
  res.status(httpStatus.OK).send('ok')

  try {
    const invite = parseInviteFromPayload(req.body)

    // The provider's docs may confirm From is always a clean address (Postmark's does; the display
    // name travels separately in FromName/FromFull.Name), but req.body is unvalidated wire input,
    // so check the shape anyway. Shared by both the invite and plain-email paths below.
    const fromAddress = req.body?.From
    if (typeof fromAddress !== 'string' || fromAddress.length === 0) {
      logger.warn('Email webhook: inbound message had no From address; cannot resolve an organizer')
      return
    }

    // Both paths below read the email body: the invite path fills gaps the .ics fields leave open,
    // the plain-email path reads it as the only source it has.
    const body = typeof req.body?.TextBody === 'string' ? req.body.TextBody : undefined

    if (invite) {
      // Times log as UTC; a bad zone conversion is otherwise invisible until the event runs an hour off.
      logger.info(
        `Email webhook: parsed invite "${invite.summary ?? '(no summary)'}" (UID ${invite.uid ?? 'none'}) ` +
          `from ${fromAddress}, organizer ${invite.organizer ?? 'none'}, ` +
          `starts ${invite.startDate?.toISOString() ?? 'unknown'}, ends ${invite.endDate?.toISOString() ?? 'unknown'}`
      )
      await createConversationFromInvite({ fromAddress, invite, body })
      return
    }

    // No .ics attachment: a plain email, on-demand join-now request rather than a calendar invite.
    const fromName = typeof req.body?.FromName === 'string' ? req.body.FromName : undefined
    const subject = typeof req.body?.Subject === 'string' ? req.body.Subject : undefined
    const messageId = typeof req.body?.MessageID === 'string' ? req.body.MessageID : undefined

    logger.info(`Email webhook: no calendar attachment from ${fromAddress}; treating as a plain on-demand email`)
    await createConversationFromEmail({ fromAddress, fromName, subject, body, messageId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`Email webhook: failed to parse inbound invite: ${message}`)
  }
}

const middleware = async (req, res, next) => {
  try {
    const { authUser, authSecret } = config.emailWebhook
    // Fail closed if the credentials aren't configured, rather than accepting every caller.
    if (!authUser || !authSecret) {
      logger.error('Email webhook: credentials are not configured; rejecting request')
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Email webhook is not configured')
    }

    const authHeader = req.headers.authorization
    if (!authHeader) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Missing email webhook credentials')
    }
    const [scheme, encoded] = authHeader.split(' ')
    if (scheme !== 'Basic' || !encoded) {
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Unsupported email webhook authorization scheme')
    }

    const decoded = Buffer.from(encoded, 'base64').toString('utf8')
    const separatorIndex = decoded.indexOf(':')
    const username = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex)
    const password = separatorIndex === -1 ? '' : decoded.slice(separatorIndex + 1)

    // Evaluate both halves regardless of the first result so the reject path can't be timed.
    const usernameValid = credentialsMatch(username, authUser)
    const passwordValid = credentialsMatch(password, authSecret)
    if (!usernameValid || !passwordValid) {
      // 401, never 403: some providers (Postmark included) stop retrying a message forever once
      // they see a 403, so a wrong-credentials response has to leave room for a retry.
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid email webhook credentials')
    }

    next()
  } catch (err) {
    next(err)
  }
}

export default { middleware, handleEvent }
