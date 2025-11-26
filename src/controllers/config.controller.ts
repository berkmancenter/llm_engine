import httpStatus from 'http-status'
import config from '../config/config.js'
import catchAsync from '../utils/catchAsync.js'
import agentTypes from '../agents/config.js'
import adapterTypes from '../adapters/config.js'
import conversationTypes from '../conversations/config.js'
import { llmPlatforms, supportedModels } from '../agents/helpers/getModelChat.js'
import { embeddingsPlatforms, supportedModels as supportedEmbeddingModels } from '../agents/helpers/getEmbeddings.js'

const getConfig = catchAsync(async (req, res) =>
  res.status(httpStatus.OK).send({
    maxMessageLength: config.maxMessageLength,
    availableAgents: agentTypes,
    availablePlatforms: adapterTypes,
    enablePublicChannelCreation: config.enablePublicChannelCreation,
    enableAutoDeletion: config.enableAutoDeletion,
    enableExportOptOut: config.enableExportOptOut,
    llmPlatforms,
    supportedModels,
    embeddingsPlatforms,
    supportedEmbeddingModels,
    conversationTypes
  })
)

const configController = {
  getConfig
}

export default configController
