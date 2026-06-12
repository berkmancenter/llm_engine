/*
 * Gates the event-setup endpoints behind a valid handoff token.
 *
 * The token is the one the Slack bot embedded in the link the organizer
 * clicked to reach the event-creation form. It carries the originating
 * Slack context (user, team, channel, thread timestamp) so later handlers
 * can post the confirmation back into the same Slack thread.
 *
 * The handoff token is the ONLY authorization on these endpoints. There
 * is deliberately no Nextspace user session check because the organizer
 * may not be logged into Nextspace at all — they arrive directly from a
 * Slack click. So any failure path (no token, bad signature, wrong type,
 * expired) has to return 401.
 *
 * On success, the verified Slack context is attached to req.handoff so
 * the route handler can use it.
 */

import httpStatus from 'http-status'
import ApiError from '../utils/ApiError.js'
import { verifyHandoffToken, VerifiedHandoffContext } from '../services/handoff.service.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      handoff?: VerifiedHandoffContext
    }
  }
}

const handoffAuth = (req, res, next) => {
  const token = req.header('x-handoff-token')
  if (!token) {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Missing handoff token'))
  }
  try {
    req.handoff = verifyHandoffToken(token)
    return next()
  } catch {
    return next(new ApiError(httpStatus.UNAUTHORIZED, 'Invalid handoff token'))
  }
}

export default handoffAuth
