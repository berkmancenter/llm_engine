import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import parseChannelParams from '../utils/channelParams.js'
import { messageService, messageHideService } from '../services/index.js'
import serializeMessage from '../utils/serializeMessage.js'

const createMessage = catchAsync(async (req, res) => {
  const sentMessages = await messageService.newMessageHandler(req.body, req.user)
  res.status(httpStatus.CREATED).send(sentMessages.map(serializeMessage))
})
const conversationMessages = catchAsync(async (req, res) => {
  const channels = parseChannelParams(req.query.channel)
  const messages = await messageService.conversationMessages(req.params.conversationId, channels, req.user)
  res.status(httpStatus.OK).send(messages)
})
const vote = catchAsync(async (req, res) => {
  const message = await messageService.vote(req.params.messageId, req.body.direction, req.body.status, req.user)
  res.status(httpStatus.OK).send(message)
})

const messageReplies = catchAsync(async (req, res) => {
  // const userId = req.user ? req.user.id : null
  const replies = await messageService.getMessageReplies(req.params.messageId, req.user)
  res.status(httpStatus.OK).send(replies)
})

const hideMessage = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).send(await messageHideService.hideMessage(req.params.messageId, req.user, req.body?.reason))
})
const unhideMessage = catchAsync(async (req, res) => {
  res.status(httpStatus.OK).send(await messageHideService.unhideMessage(req.params.messageId, req.user, req.body?.reason))
})
const hideUserMessages = catchAsync(async (req, res) => {
  const { conversationId, userId } = req.params
  res
    .status(httpStatus.OK)
    .send(await messageHideService.hideUserMessages(conversationId, userId, req.user, req.body?.reason))
})
const unhideUserMessages = catchAsync(async (req, res) => {
  const { conversationId, userId } = req.params
  res
    .status(httpStatus.OK)
    .send(await messageHideService.unhideUserMessages(conversationId, userId, req.user, req.body?.reason))
})

const moderationEvents = catchAsync(async (req, res) => {
  const { limit, page } = req.query
  const events = await messageHideService.listModerationEvents(req.params.conversationId, req.user, { limit, page })
  res.status(httpStatus.OK).send(events)
})

export {
  moderationEvents,
  createMessage,
  conversationMessages,
  vote,
  messageReplies,
  hideMessage,
  unhideMessage,
  hideUserMessages,
  unhideUserMessages
}
