/* eslint-disable security/detect-non-literal-fs-filename */
import fs from 'fs'
import path from 'path'
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import backgroundCollection, { BACKGROUND_DOCS_BASE } from '../agents/helpers/backgroundCollection.js'
import logger from '../config/logger.js'
import Conversation from '../models/conversation.model.js'
import websocketGateway from '../websockets/websocketGateway.js'
import ApiError from '../utils/ApiError.js'
import { Resource } from '../types/index.types.js'

const addResources = async (newResources, conversationId) => {
  const conv = await Conversation.findByIdAndUpdate(
    conversationId,
    { $push: { resources: { $each: newResources } } },
    { new: true }
  )
    .select('resources')
    .exec()

  if (!conv) {
    throw new Error(`addResources: conversation ${conversationId} not found`)
  }

  websocketGateway.broadcastResourcesUpdated(conversationId, conv.resources as unknown[])
}

const deleteResources = async (conversationId: string) => {
  try {
    await backgroundCollection.deleteBackgroundCollection(conversationId)
  } catch (err) {
    logger.warn(`resource.service: failed to delete Chroma collection for ${conversationId}: ${err}`)
  }
  const dir = path.join(BACKGROUND_DOCS_BASE, conversationId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    logger.info(`resource.service: removed background docs dir ${dir}`)
  }
}

const resourceService = { addResources, deleteResources }
export default resourceService
