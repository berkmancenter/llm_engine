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

const savePdf = async (conversationId: string, resourceId: string, fileBuffer: Buffer, user) => {
  const conv = await Conversation.findOne({
    _id: conversationId,
    'resources._id': new mongoose.Types.ObjectId(resourceId)
  })
    .select('resources owner topic')
    .populate('topic', 'owner')
    .lean()
    .exec()

  if (!conv) {
    throw new ApiError(httpStatus.NOT_FOUND, `Resource ${resourceId} not found in conversation ${conversationId}`)
  }

  const userId = user._id.toString()
  const isConvOwner = conv.owner.toString() === userId
  const isTopicOwner = conv.topic.owner.toString() === userId
  if (!isConvOwner && !isTopicOwner) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can upload resources')
  }

  const dir = path.join(BACKGROUND_DOCS_BASE, conversationId)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = `${resourceId}.pdf`
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, fileBuffer)
  logger.info(`resource.service: wrote PDF to ${filePath}`)

  await Conversation.updateOne(
    { _id: conversationId, 'resources._id': new mongoose.Types.ObjectId(resourceId) },
    { $set: { 'resources.$.fileName': fileName } }
  ).exec()

  const resource = conv.resources.find((r) => r._id!.toString() === resourceId)
  if (resource) {
    try {
      await backgroundCollection.loadPdfIntoChroma(conversationId, { ...resource, fileName })
    } catch (err) {
      logger.warn(`resource.service: failed to load PDF into Chroma for resource ${resourceId}: ${err}`)
    }
  }
  return fileName
}

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

const resourceService = { savePdf, addResources, deleteResources }
export default resourceService
