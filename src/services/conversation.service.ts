import mongoose from 'mongoose'
import httpStatus from 'http-status'
import handlebars from 'handlebars'
import { Conversation, Topic, Follower, Message, Channel, Agent } from '../models/index.js'
import updateDocument from '../utils/updateDocument.js'
import ApiError from '../utils/ApiError.js'
import websocketGateway from '../websockets/websocketGateway.js'
import agentService from './agent.service/index.js'
import Adapter from '../models/adapter.model.js'
import schedule from '../jobs/schedule.js'
import defineJob from '../jobs/define.js'

import logger from '../config/logger.js'
import adapterService from './adapter.service.js'
import channelService from './channel.service.js'
import { ConversationDocument } from '../models/conversation.model.js'
import { getConversationType } from '../conversations/index.js'
import { supportedModels } from '../agents/helpers/getEmbeddings.js'
import transcript from '../agents/helpers/transcript.js'

const returnFields =
  'name slug locked owner createdAt active conversationType platforms scheduledTime description moderators presenters'
const transcriptBatchInterval = 30
export const maxScheduledInterval = 10 * 60 * 1000 // 10 minutes in milliseconds
/**
 * Removed messages array property and replaces with messageCount
 * @param {Array} conversations
 * @returns {Array}
 */
const addMessageCount = async (conversations) => {
  const counts = await Promise.all(conversations.map((c) => c.messageCount()))
  return conversations.map((conversation, index) => {
    const c = conversation.toObject()
    c.messageCount = counts[index]
    // Replace _id with id since toJSON plugin will not be applied
    c.id = c._id.toString()
    delete c._id
    return c
  })
}

async function scheduleTranscriptBatching(conversation) {
  await schedule.cancelBatchTranscript(conversation._id)
  await defineJob.batchTranscript(conversation._id)
  await schedule.batchTranscript(`${transcriptBatchInterval} seconds`, { conversationId: conversation._id })
}

const startConversation = async (conversationOrId, user) => {
  let conversation = conversationOrId
  if (typeof conversationOrId === 'string' || conversationOrId instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversationOrId })
    if (!conversation) {
      throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationOrId} not found`)
    }
  }
  await conversation.populate(['topic', 'agents', 'adapters'])
  if (
    user._id.toString() !== conversation.owner._id.toString() &&
    user._id.toString() !== conversation.topic.owner._id.toString()
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can start conversation')
  }
  logger.debug(`Start conversation: ${conversation._id}`)

  conversation.startTime = Date.now()
  let transcriptRAG = false
  for (const agent of conversation.agents) {
    // needed so agent has all conversation info for activation
    agent.conversation = conversation
    await agentService.startAgent(agent)
    if (agent.useTranscriptRAGCollection) {
      transcriptRAG = true
    }
  }
  if (transcriptRAG) {
    await scheduleTranscriptBatching(conversation)
  }
  for (const adapter of conversation.adapters) {
    adapter.conversation = conversation
    await adapterService.start(adapter)
  }

  conversation.active = true
  await conversation.save()
  return conversation
}

const stopConversation = async (conversationOrId, user) => {
  let conversation = conversationOrId
  if (typeof conversationOrId === 'string' || conversationOrId instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversationOrId })
    if (!conversation) {
      throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationOrId} not found`)
    }
  }
  await conversation.populate(['topic', 'agents', 'adapters'])
  if (user._id.toString() !== conversation.owner.toString() && user._id.toString() !== conversation.topic.owner.toString()) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can stop conversation')
  }
  logger.debug(`Stop conversation: ${conversation._id}`)

  conversation.endTime = new Date(Date.now())
  let transcriptRAG = false
  for (const agent of conversation.agents) {
    // needed so agent has all conversation info for activation
    agent.conversation = conversation
    await agentService.stopAgent(agent)
    if (agent.useTranscriptRAGCollection) {
      transcriptRAG = true
    }
  }
  if (transcriptRAG) {
    await schedule.cancelBatchTranscript(conversation._id)
  }

  for (const adapter of conversation.adapters) {
    adapter.conversation = conversation
    await adapterService.stop(adapter)
  }

  conversation.active = false
  await conversation.save()
  return conversation
}
/**
 * Create a conversation
 * @param {Object} conversationBody
 * @returns {Promise<Conversation>}
 */
const createConversation = async (conversationBody, user) => {
  if (!conversationBody.topicId) throw new ApiError(httpStatus.BAD_REQUEST, 'topic id must be passed in request body')
  const topicId = new mongoose.Types.ObjectId(conversationBody.topicId)
  const topic = await Topic.findById(topicId)
  if (!topic) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No such topic')
  }
  if (!topic?.conversationCreationAllowed && user._id.toString() !== topic?.owner.toString()) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Conversation creation not allowed.')
  }

  const { embeddingsPlatform, embeddingsModelName } = conversationBody.transcript?.vectorStore ?? {}
  if (embeddingsPlatform || embeddingsModelName) {
    if (!supportedModels.find((m) => embeddingsPlatform === m.platform && embeddingsModelName === m.model))
      throw new Error('No such supported embedding model')
  }

  const conversation = new Conversation({
    name: conversationBody.name,
    owner: user,
    topic,
    enableAgents: !!conversationBody.agentTypes?.length,
    ...(conversationBody.enableDMs !== undefined && { enableDMs: conversationBody.enableDMs }),
    ...(conversationBody.conversationType !== undefined && { conversationType: conversationBody.conversationType }),
    ...(conversationBody.platforms !== undefined && { platforms: conversationBody.platforms }),
    ...(conversationBody.description !== undefined && { description: conversationBody.description }),
    ...(conversationBody.moderators !== undefined && { moderators: conversationBody.moderators }),
    ...(conversationBody.presenters !== undefined && { presenters: conversationBody.presenters }),
    agents: [],
    transcript: conversationBody.transcript,
    scheduledTime: conversationBody.scheduledTime
  })
  // need to save to get id
  await conversation.save()

  let transcriptRAG = false

  for (const agentType of conversationBody.agentTypes || []) {
    let agent
    if (typeof agentType === 'string') {
      agent = await agentService.createAgent(agentType, conversation)
    } else {
      agent = await agentService.createAgent(agentType.name, conversation, agentType.properties)
    }
    if (agent.useTranscriptRAGCollection) {
      transcriptRAG = true
    }
    conversation.agents.push(agent)
  }

  for (const adapterProps of conversationBody.adapters || []) {
    const adapter = await adapterService.createAdapter(adapterProps, conversation)
    conversation.adapters.push(adapter)
  }

  for (const channelProps of conversationBody.channels || []) {
    await channelService.createChannel(conversation, channelProps)
  }

  topic.conversations.push(conversation.toObject())
  await Promise.all([conversation.save(), topic.save()])
  if (transcriptRAG) {
    await transcript.loadEventMetadataIntoVectorStore(conversation)
  }

  websocketGateway.broadcastNewConversation(conversation)

  // Assume immediate start if not scheduled
  if (!conversation.scheduledTime) {
    await startConversation(conversation, user)
  }
  return conversation
}

/**
 * Remove empty values from an object recursively
 * @param {any} obj
 * @returns {any}
 */
const removeEmptyValues = (obj) => {
  if (Array.isArray(obj)) {
    return obj.map(removeEmptyValues).filter((item) => item !== null)
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const cleanedValue = removeEmptyValues(value)
      if (cleanedValue !== '') {
        acc[key] = cleanedValue
      }
      return acc
    }, {})
  }
  return obj
}

/**
 * Resolve property references in an object
 * @param {any} obj - Object containing property references like {{properties.propertyName}}
 * @param {Object} properties - Property values to substitute
 * @returns {any} Object with resolved references
 */
const resolvePropertyReferences = (obj, properties) => {
  const template = handlebars.compile(JSON.stringify(obj))
  const resolved = template({ properties })
  const parsed = JSON.parse(resolved)
  return removeEmptyValues(parsed)
}

/**
 * Create a conversation from a conversation type specification
 * @param {Object} params - { type, name, platforms, topicId, properties, scheduledTime }
 * @param {Object} user
 * @returns {Promise<Conversation>}
 */
const createConversationFromType = async (params, user) => {
  const { type, platforms, properties = {} } = params

  const conversationType = getConversationType(type)
  if (!conversationType) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation type ${type} not found`)
  }

  const invalidPlatforms = platforms?.filter((p) => !conversationType.platforms.some((cp) => cp.name === p))

  if (invalidPlatforms && invalidPlatforms.length) {
    throw new ApiError(httpStatus.NOT_FOUND, `Invalid platform(s): ${invalidPlatforms.join(', ')}`)
  }

  // Validate required properties
  for (const prop of conversationType.properties) {
    if (prop.required && !(prop.name in properties)) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Required property '${prop.name}' is missing`)
    }

    // Validate enum constraints
    if (prop.enum && prop.name in properties) {
      const value = properties[prop.name]
      const isAllowed = prop.enum.some((item) => {
        if (typeof item === 'object') {
          if (typeof value !== 'object' || value === null) return false

          // Use validationKeys if specified, otherwise use all keys from enum item
          const keysToValidate = prop.validationKeys || Object.keys(item)

          // Check if all validation keys match
          return keysToValidate.every((k) => value[k] === item[k])
        }
        return item === value
      })

      if (!isAllowed) {
        const allowedValues = prop.enum
          .map((item) => {
            if (typeof item === 'object') {
              // Show only validation keys in error message
              const keysToShow = prop.validationKeys || Object.keys(item)
              const filteredItem = Object.fromEntries(keysToShow.map((k) => [k, item[k]]))
              return JSON.stringify(filteredItem)
            }
            return item
          })
          .join(', ')
        throw new ApiError(httpStatus.BAD_REQUEST, `Invalid value for '${prop.name}'. Must be one of: ${allowedValues}`)
      }
    }
  }

  // Apply defaults for missing optional properties
  const resolvedProperties = { ...properties }
  for (const prop of conversationType.properties) {
    if (!prop.required && !(prop.name in resolvedProperties) && prop.default !== undefined) {
      resolvedProperties[prop.name] = prop.default
    }
  }

  const adapters = conversationType.adapters || {}
  const matched = (platforms || []).map((p) => adapters[p]).filter(Boolean)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let adapterConfigs: any = []

  if (matched.length > 0) {
    adapterConfigs = matched.map((a) => resolvePropertyReferences(a, resolvedProperties))
  } else if (adapters.default) {
    adapterConfigs = [resolvePropertyReferences(adapters.default, resolvedProperties)]
  }

  // Resolve property references in agents
  const resolvedAgents = conversationType.agents
    ? resolvePropertyReferences(conversationType.agents, resolvedProperties)
    : []

  const conversationBody = {
    ...params,
    conversationType: type,
    agentTypes: resolvedAgents,
    adapters: adapterConfigs,
    channels: conversationType.channels || [],
    enableDMs: conversationType.enableDMs
  }

  return createConversation(conversationBody, user)
}
/**
 * Update a conversation
 * @param {Object} conversationBody
 * @returns {Promise<Conversation>}
 */
const updateConversation = async (conversationBody, user) => {
  let conversationDoc = await Conversation.findById(conversationBody.id).populate('topic')
  if (!conversationDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationBody.id} not found`)
  }
  if (
    user._id.toString() !== conversationDoc.owner.toString() &&
    user._id.toString() !== conversationDoc.topic.owner.toString()
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can update.')
  }
  conversationDoc = updateDocument(conversationBody, conversationDoc)
  await conversationDoc!.save()
  let transcriptRAG = false
  for (const agent of conversationDoc!.agents) {
    if (agent.useTranscriptRAGCollection) {
      transcriptRAG = true
    }
  }
  if (transcriptRAG) {
    await transcript.loadEventMetadataIntoVectorStore(conversationDoc!)
  }
  websocketGateway.broadcastConversationUpdate(conversationDoc)
  return conversationDoc
}
const userConversations = async (user) => {
  const deletedTopics = await Topic.find({ isDeleted: true }).select('_id')
  const followedConversations = await Follower.find({ user }).select('conversation').exec()
  const followedConversationsIds = followedConversations.map((el) => el.conversation).filter((el) => el)
  let conversations = await Conversation.find({
    $and: [
      { $or: [{ owner: user }, { _id: { $in: followedConversationsIds } }] },
      {
        topic: { $nin: deletedTopics }
      },
      {
        experimental: { $ne: true }
      }
    ]
  })
    .populate({ path: 'messages', select: 'id visible' })
    .select(returnFields)
    .exec()
  conversations = await addMessageCount(conversations)
  conversations.forEach((conversation) => {
    if (followedConversationsIds.map((f) => f.toString()).includes(conversation.id)) {
      // eslint-disable-next-line
      conversation.followed = true
    }
  })
  return conversations
}
const findById = async (id) => {
  const conversation = await Conversation.findOne({ _id: id }).populate('followers').select('name slug owner').exec()
  return conversation
}
const findByIdFull = async (id, user) => {
  const conversation = await Conversation.findOne({ _id: id })
    .select(returnFields)
    .populate('agents')
    .populate('channels')
    .populate('adapters')
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${id} not found`)
  }
  const followed = Follower.findOne({ conversation, user }).select('_id').exec() !== null
  const conversationPojo = conversation.toObject({
    transform: (doc, ret: ConversationDocument) => {
      // Only transform the top-level conversation document
      if (doc !== conversation) {
        return ret
      }
      const { _id, ...cleanRet } = ret
      // display channel passcodes only to conversation owner
      let { channels } = cleanRet
      if (channels && user._id.toString() !== conversation.owner.toString()) {
        channels = channels.map((channel) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { passcode, ...channelWithoutPasscode } = channel
          return channelWithoutPasscode
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any[]
      }
      return {
        ...cleanRet,
        id: _id.toString(),
        followed,
        ...(channels && { channels })
      }
    }
  })

  return conversationPojo
}
const topicConversations = async (topicId) => {
  const conversations = await Conversation.find({ topic: topicId, experimental: { $ne: true } })
    .populate({ path: 'messages', select: 'id visible' })
    .select(returnFields)
    .exec()
  return addMessageCount(conversations)
}
const follow = async (status, conversationId, user) => {
  const conversation = await findById(conversationId)
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }
  const params = {
    user,
    conversation
  }
  if (status === true) {
    const follower = await Follower.create(params)
    conversation.followers.push(follower.toObject())
    conversation.save()
  } else {
    await Follower.deleteMany(params)
  }
}
const allPublic = async () => {
  const deletedTopics = await Topic.find({ isDeleted: true }).select('_id')
  const conversations = await Conversation.find({ topic: { $nin: deletedTopics }, experimental: { $ne: true } })
    .select(returnFields)
    .populate({ path: 'messages', select: 'id visible' })
    .exec()
  return addMessageCount(conversations)
}

const activeConversations = async () => {
  const deletedTopics = await Topic.find({ isDeleted: true }).select('_id')
  const conversations = await Conversation.find({
    topic: { $nin: deletedTopics },
    experimental: { $ne: true },
    active: true
  })
    .select(returnFields)
    .populate({ path: 'messages', select: 'id visible' })
    .exec()
  return addMessageCount(conversations)
}

const deleteConversation = async (id, user) => {
  const conversation = await Conversation.findOne({ _id: id })
    .populate(['topic', 'agents'])
    .select('name slug owner topic active channels')
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${id} not found`)
  }
  if (user._id.toString() !== conversation.owner.toString() && user._id.toString() !== conversation.topic.owner.toString()) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can delete.')
  }
  if (conversation.active) {
    await stopConversation(id, user)
  }

  try {
    await transcript.deleteTranscript(conversation)
  } catch {
    logger.warn(`Failed to delete transcript for conversation ${conversation._id}.`)
  }

  if (conversation.channels && conversation.channels.length > 0) {
    await Channel.deleteMany({ _id: { $in: conversation.channels } })
  }
  await Conversation.deleteOne({ _id: id })
  await Follower.deleteMany({ conversation })
  await Message.deleteMany({ conversation })
  await Agent.deleteMany({ conversation })
  await Adapter.deleteMany({ conversation })
}
const patchConversationAgent = async (id, agentId, body, user) => {
  const conversation = await Conversation.findOne({ _id: id }).populate('topic').populate('agents').exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${id} not found`)
  }
  const agentIdStr = agentId.toString() ? agentId.toString() : agentId
  if (user._id.toString() !== conversation.owner.toString() && user._id.toString() !== conversation.topic.owner.toString()) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can patch agents')
  }
  const agent = conversation.agents.find((a) => a._id!.toString() === agentIdStr)
  if (!agent) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No such agent on this conversation')
  }
  await agentService.patchAgent(agent, body)
  return agent
}

const joinConversation = async (conversationOrId, user) => {
  let conversation = conversationOrId
  if (typeof conversationOrId === 'string' || conversationOrId instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversationOrId })
      .select(returnFields)
      .select('enableDMs agents channels')

    if (!conversation) {
      throw new ApiError(httpStatus.NOT_FOUND, `Conversation with ID ${conversationOrId} not found`)
    }
  }
  if (!conversation.enableDMs.includes('agents')) {
    return conversation
  }
  await conversation.populate(['channels', 'agents'])

  for (const agent of conversation.agents) {
    const directChannelName = `direct-${user._id}-${agent._id}`
    if (!conversation.channels?.find((channel) => channel.name === directChannelName)) {
      await channelService.createChannel(conversation, {
        name: directChannelName,
        direct: true,
        participants: [user, agent],
        passcode: null
      })
    }
  }
  return conversation
}

const conversationService = {
  createConversation,
  createConversationFromType,
  userConversations,
  findById,
  topicConversations,
  activeConversations,
  follow,
  findByIdFull,
  allPublic,
  deleteConversation,
  updateConversation,
  patchConversationAgent,
  startConversation,
  stopConversation,
  joinConversation
}
export default conversationService
