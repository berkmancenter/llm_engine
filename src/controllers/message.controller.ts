import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { messageService } from '../services/index.js'

const createMessage = catchAsync(async (req, res) => {
  const sentMessages = await messageService.newMessageHandler(req.body, req.user)
  res.status(httpStatus.CREATED).send(sentMessages)
})
const conversationMessages = catchAsync(async (req, res) => {
  // zero, one or more channel,code pairs
  const channels =
    req.query.channel &&
    (Array.isArray(req.query.channel) ? req.query.channel : [req.query.channel]).map((c) => {
      const parts = c.split(',').map((p) => p.trim())
      return { name: parts[0], passcode: parts[1] }
    })
  const messages = await messageService.conversationMessages(req.params.conversationId, channels)
  res.status(httpStatus.OK).send(messages)
})
const vote = catchAsync(async (req, res) => {
  const message = await messageService.vote(req.params.messageId, req.body.direction, req.body.status, req.user)
  res.status(httpStatus.OK).send(message)
})

const messageReplies = catchAsync(async (req, res) => {
  // const userId = req.user ? req.user.id : null
  const replies = await messageService.getMessageReplies(req.params.messageId)
  res.status(httpStatus.OK).send(replies)
})

export { createMessage, conversationMessages, vote, messageReplies }
