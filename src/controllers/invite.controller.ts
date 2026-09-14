import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { inviteService } from '../services/index.js'

/* The invite screens carry a live token and nonce, so their responses must never be
   cached or send a referrer. Set before any work so error responses carry the headers
   too. */
const setInviteScreenHeaders = (res) => {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
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
  await inviteService.consumeInvite(req.body.token, req.body.nonce)
  /* Account provisioning and session issuance follow in the set-password work. Consuming
     without them is safe to ship first because no invite email can go out until the
     Postmark batch send exists, so no real token can be stranded. */
  res.status(httpStatus.OK).send({ consumed: true })
})

export { sendInvites, resendInvite, getInvite, consumeInvite }
