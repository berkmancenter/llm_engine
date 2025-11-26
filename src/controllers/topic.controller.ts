import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { topicService, userService, tokenService } from '../services/index.js'
import ApiError from '../utils/ApiError.js'
import tokenTypes from '../config/tokens.js'

const createTopic = catchAsync(async (req, res) => {
  const topic = await topicService.createTopic(req.body, req.user)
  res.status(httpStatus.CREATED).send(topic)
})
const updateTopic = catchAsync(async (req, res) => {
  const topic = await topicService.updateTopic(req.body)
  res.status(httpStatus.OK).send(topic)
})
const userTopics = catchAsync(async (req, res) => {
  const topics = await topicService.userTopics(req.user)
  res.status(httpStatus.OK).send(topics)
})
const follow = catchAsync(async (req, res) => {
  await topicService.follow(req.body.status, req.body.topicId, req.user)
  res.status(httpStatus.OK).send('ok')
})
const getTopic = catchAsync(async (req, res) => {
  const topic = await topicService.findById(req.params.topicId)
  res.status(httpStatus.OK).send(topic)
})
const deleteTopic = catchAsync(async (req, res) => {
  await topicService.deleteTopic(req.params.topicId)
  res.status(httpStatus.OK).send()
})
const allTopics = catchAsync(async (req, res) => {
  const topics = await topicService.allTopicsByUser(req.user)
  res.status(httpStatus.OK).send(topics)
})
const publicTopics = catchAsync(async (req, res) => {
  if (userService.isTokenGeneratedByConversations(req.params.token) === false) {
    throw new Error('Invalid or expired login token. Please log in again.')
  }
  const topics = await topicService.allPublicTopics()
  // Return top ten topics
  res.status(httpStatus.OK).send(topics.slice(0, 10))
})
const authenticate = catchAsync(async (req, res) => {
  const result = await topicService.verifyPasscode(req.body.topicId, req.body.passcode)
  if (!result) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Invalid passcode')
  }
  res.status(httpStatus.OK).send()
})
const archiveTopic = catchAsync(async (req, res) => {
  await tokenService.verifyToken(req.body.token, tokenTypes.ARCHIVE_TOPIC)
  await topicService.archiveTopic(req.body.token, req.body.topicId)
  res.status(httpStatus.OK).send()
})

export {
  createTopic,
  updateTopic,
  userTopics,
  getTopic,
  allTopics,
  publicTopics,
  authenticate,
  archiveTopic,
  deleteTopic,
  follow
}
