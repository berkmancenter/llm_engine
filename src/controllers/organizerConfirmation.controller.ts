import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import organizerConfirmationService from '../services/eventSetup/organizerConfirmation.service.js'

/* This screen carries a live token and nonce, so its response must never be cached or send a
   referrer. Set before any work so error responses carry the headers too. */
const setConfirmationScreenHeaders = (res) => {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
}

/*
 * Confirms the organizer behind a relayed calendar invite, whose Reply-To header may not be verified (e.g. Zoom
 * itself never verifies) — see organizerConfirmation.service.ts and emailSetup.service.ts's
 * resolveOrganizer. Does not consume the token: mail scanners (Proofpoint, Safe Links) pre-fetch
 * emailed links with a GET, so this path must be safe to repeat.
 */
const getConfirmation = catchAsync(async (req, res) => {
  setConfirmationScreenHeaders(res)
  const result = await organizerConfirmationService.describeConfirmation(req.query.token as string)
  res.status(httpStatus.OK).send(result)
})

/* Burns the single-use confirmation token, requiring the nonce the GET above issued so a token
   skimmed from a log or scanner queue cannot complete the flow on its own. */
const confirmOrganizer = catchAsync(async (req, res) => {
  setConfirmationScreenHeaders(res)
  const conversation = await organizerConfirmationService.confirmOrganizer(req.body.token, req.body.nonce)
  res.status(httpStatus.OK).send({ conversationId: conversation._id.toString(), draft: conversation.draft })
})

export { getConfirmation, confirmOrganizer }
