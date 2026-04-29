import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { conversationService } from '../services/index.js'

const createConversation = catchAsync(async (req, res) => {
  const conversation = await conversationService.createConversation(req.body, req.user)
  res.status(httpStatus.CREATED).send(conversation)
})
const createConversationFromType = catchAsync(async (req, res) => {
  const conversation = await conversationService.createConversationFromType(req.body, req.user)
  res.status(httpStatus.CREATED).send(conversation)
})
const startConversation = catchAsync(async (req, res) => {
  const conversation = await conversationService.startConversation(req.params.conversationId, req.user)
  res.status(httpStatus.OK).send(conversation)
})
const stopConversation = catchAsync(async (req, res) => {
  const conversation = await conversationService.stopConversation(req.params.conversationId, req.user)
  res.status(httpStatus.OK).send(conversation)
})
const updateConversation = catchAsync(async (req, res) => {
  const conversation = await conversationService.updateConversation(req.body, req.user)
  res.status(httpStatus.OK).send(conversation)
})
const userConversations = catchAsync(async (req, res) => {
  const conversations = await conversationService.userConversations(req.user)
  res.status(httpStatus.OK).send(conversations)
})
const activeConversations = catchAsync(async (req, res) => {
  const conversations = await conversationService.activeConversations()
  res.status(httpStatus.OK).send(conversations)
})
const getConversation = catchAsync(async (req, res) => {
  const conversation = await conversationService.findByIdFull(req.params.conversationId, req.user)
  res.status(httpStatus.OK).send(conversation)
})
const getTopicConversations = catchAsync(async (req, res) => {
  const conversations = await conversationService.topicConversations(req.params.topicId)
  res.status(httpStatus.OK).send(conversations)
})
const follow = catchAsync(async (req, res) => {
  await conversationService.follow(req.body.status, req.body.conversationId, req.user)
  res.status(httpStatus.OK).send('ok')
})
const allPublic = catchAsync(async (req, res) => {
  const conversations = await conversationService.allPublic()
  res.status(httpStatus.OK).send(conversations)
})
const deleteConversation = catchAsync(async (req, res) => {
  await conversationService.deleteConversation(req.params.conversationId, req.user)
  res.status(httpStatus.OK).send()
})
const patchConversationAgent = catchAsync(async (req, res) => {
  const agent = await conversationService.patchConversationAgent(
    req.params.conversationId,
    req.params.agentId,
    req.body,
    req.user
  )
  res.status(httpStatus.OK).send(agent)
})

const joinConversation = catchAsync(async (req, res) => {
  const conversation = await conversationService.joinConversation(req.params.conversationId, req.user)
  res.status(httpStatus.OK).send(conversation)
})

const getConversationReport = catchAsync(async (req, res) => {
  const { conversationId } = req.params
  const { reportName, format = 'text', additionalChannels, agent } = req.query
  const timezone = req.headers['x-timezone'] || 'UTC'

  // Parse additionalChannels - can be a comma-separated string or array
  let channelsArray: string[] = []
  if (additionalChannels) {
    if (Array.isArray(additionalChannels)) {
      channelsArray = additionalChannels as string[]
    } else if (typeof additionalChannels === 'string') {
      channelsArray = additionalChannels.split(',').map((ch) => ch.trim())
    }
  }

  const report = await conversationService.generateConversationReport(
    conversationId,
    reportName,
    format,
    timezone,
    channelsArray,
    agent as string | undefined
  )

  const contentTypes = {
    text: 'text/plain',
    csv: 'text/csv'
  }
  res.setHeader('Content-Type', contentTypes[format] || 'text/plain')

  if (format === 'csv') {
    res.setHeader('Content-Disposition', `attachment; filename="${reportName}_${conversationId}.csv"`)
  }

  res.status(httpStatus.OK).send(report)
})

const getFeatures = catchAsync(async (req, res) => {
  const result = await conversationService.getFeatures(req.params.conversationId)
  res.status(httpStatus.OK).send(result)
})

export {
  createConversation,
  createConversationFromType,
  updateConversation,
  userConversations,
  activeConversations,
  getConversation,
  getTopicConversations,
  follow,
  allPublic,
  deleteConversation,
  patchConversationAgent,
  startConversation,
  stopConversation,
  joinConversation,
  getConversationReport,
  getFeatures
}
