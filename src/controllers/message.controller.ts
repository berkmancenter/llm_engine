import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import parseChannelParams from '../utils/channelParams.js'
import { messageService } from '../services/index.js'

const createMessage = catchAsync(async (req, res) => {
  const sentMessages = await messageService.newMessageHandler(req.body, req.user)
  res.status(httpStatus.CREATED).send(sentMessages)
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

export { createMessage, conversationMessages, vote, messageReplies }
