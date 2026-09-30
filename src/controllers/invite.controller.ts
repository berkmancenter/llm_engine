import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { inviteService, userService } from '../services/index.js'

/* The invite screens carry a live token and nonce, so their responses must never be
   cached or send a referrer. Set before any work so error responses carry the headers
   too. */
const setInviteScreenHeaders = (res) => {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
}

/* One body for every outcome, so the response never reveals whether the link belonged to
   anyone or why nothing was sent. */
const publicResendAccepted = {
  message: 'If this invite link was valid, a new one is on its way to the address it came to.'
}

const sendInvites = catchAsync(async (req, res) => {
  const result = await inviteService.sendInvitesForConversation(req.params.conversationId, req.user)
  res.status(httpStatus.OK).send(result)
})

const resendInvite = catchAsync(async (req, res) => {
  const result = await inviteService.resendInvite(req.params.membershipId, req.user)
  res.status(httpStatus.OK).send(result)
})

const getInvite = catchAsync(async (req, res) => {
  setInviteScreenHeaders(res)
  const result = await inviteService.describeInvite(req.query.token as string)
  res.status(httpStatus.OK).send(result)
})

const consumeInvite = catchAsync(async (req, res) => {
  setInviteScreenHeaders(res)
  const result = await inviteService.consumeInvite(req.body.token, req.body.nonce, req.body.password)
  // Same shape as /auth/login and /auth/register (see auth.controller.ts).
  result.user.goodReputation = await userService.goodReputation(result.user)
  res.status(httpStatus.OK).send(result)
})

const resendInviteFromDeadLink = catchAsync(async (req, res) => {
  setInviteScreenHeaders(res)
  if (!res.locals.inviteResendRateLimited) {
    await inviteService.resendInviteFromDeadLink(req.body.token)
  }
  res.status(httpStatus.ACCEPTED).send(publicResendAccepted)
})

export { sendInvites, resendInvite, getInvite, consumeInvite, resendInviteFromDeadLink }
