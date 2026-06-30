import mongoose from 'mongoose'
import httpStatus from 'http-status'
import { Conversation, Topic, Follower, Message, Channel, Agent } from '../../models/index.js'
import updateDocument from '../../utils/updateDocument.js'
import ApiError from '../../utils/ApiError.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import agentService from '../agent.service/index.js'
import Adapter from '../../models/adapter.model.js'
import schedule from '../../jobs/schedule.js'
import defineJob from '../../jobs/define.js'
import logger from '../../config/logger.js'
import config from '../../config/config.js'
import adapterService from '../adapter.service.js'
import channelService from '../channel.service.js'
import { ConversationDocument } from '../../models/conversation.model.js'
import { getConversationType } from '../../conversations/index.js'
import adapterTypes from '../../adapters/index.js'
import resolveConversationType from '../../conversations/resolver.js'
import { supportedModels } from '../../agents/helpers/getEmbeddings.js'
import transcript from '../../agents/helpers/transcript.js'
import reportService from '../report.service.js'
import { doStartConversation, doStopConversation, updateTranscriptStatus } from './lifecycle.js'
import resourceService from '../resource.service.js'

export { updateTranscriptStatus }

const returnFields =
  'name slug locked owner createdAt active conversationType platforms scheduledTime scheduledEndTime startTime endTime description moderators presenters transcript properties features'
export const maxScheduledInterval = 10 * 60 * 1000 // 10 minutes in milliseconds
export const { autoStartLeadTimeMs } = config.conversation
export const { autoStopDelayMs } = config.conversation

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
  return doStartConversation(conversation)
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
  return doStopConversation(conversation)
}

const autoStart = async (conversationId) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
  if (!conversation) {
    logger.warn(`Auto-start: conversation ${conversationId} not found`)
    return
  }
  if (conversation.active) {
    logger.debug(`Auto-start: conversation ${conversationId} already active, skipping`)
    return
  }
  await conversation.populate(['topic', 'agents', 'adapters'])
  return doStartConversation(conversation)
}

const autoStop = async (conversationId) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
  if (!conversation) {
    logger.warn(`Auto-stop: conversation ${conversationId} not found`)
    return
  }
  if (!conversation.active) {
    logger.debug(`Auto-stop: conversation ${conversationId} already inactive, skipping`)
    return
  }
  await conversation.populate(['topic', 'agents', 'adapters'])
  return doStopConversation(conversation)
}

async function scheduleConversationAutoStart(conversation) {
  await schedule.cancelAutoStartConversation(conversation._id)
  await defineJob.autoStartConversation(conversation._id)
  const scheduledAt = new Date(conversation.scheduledTime.getTime() - autoStartLeadTimeMs)
  await schedule.autoStartConversation(scheduledAt, { conversationId: conversation._id })
  logger.debug(`Scheduled auto-start for conversation ${conversation._id} at ${scheduledAt}`)
}

async function scheduleConversationAutoStop(conversation) {
  await schedule.cancelAutoStopConversation(conversation._id)
  await defineJob.autoStopConversation(conversation._id)
  const scheduledAt = new Date(conversation.scheduledEndTime.getTime() + autoStopDelayMs)
  await schedule.autoStopConversation(scheduledAt, { conversationId: conversation._id })
  logger.debug(`Scheduled auto-stop for conversation ${conversation._id} at ${scheduledAt}`)
}

async function scheduleConversationEndingSoon(conversation) {
  await defineJob.conversationEndingSoon(conversation._id)
  // Schedule maxScheduledInterval before the scheduled end time;
  // this could eventually become configurable in conversation object
  // Failsafe: do nothing if event is somehow less than 10 minutes long as scheduled
  if (conversation.scheduledEndTime.getTime() - maxScheduledInterval < new Date().getTime()) {
    logger.debug(`Conversation ${conversation._id} ending soon event skipped due to short duration`)
    return
  }
  const scheduledAt = new Date(conversation.scheduledEndTime.getTime() - maxScheduledInterval)
  await schedule.conversationEndingSoon(scheduledAt, { conversationId: conversation._id })
  logger.debug(`Scheduled conversation ending soon for conversation ${conversation._id} at ${scheduledAt}`)
}

const initializeConversations = async () => {
  const now = new Date()
  const pendingStart = await Conversation.find({ scheduledTime: { $gt: now }, active: false })
  for (const conversation of pendingStart) {
    await defineJob.autoStartConversation(conversation._id)
  }
  const pendingStop = await Conversation.find({ scheduledEndTime: { $gt: now } })
  for (const conversation of pendingStop) {
    await defineJob.autoStopConversation(conversation._id)
  }
  logger.debug(`Conversations initialized: ${pendingStart.length} pending start, ${pendingStop.length} pending stop`)
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

  if (conversationBody.scheduledTime && new Date(conversationBody.scheduledTime) <= new Date()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'scheduledTime must be in the future')
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
    ...(conversationBody.properties !== undefined && { properties: conversationBody.properties }),
    ...(conversationBody.analyticsRefs !== undefined && { analyticsRefs: conversationBody.analyticsRefs }),
    ...(conversationBody.features !== undefined && { features: conversationBody.features }),
    ...(conversationBody.resources !== undefined && { resources: conversationBody.resources }),
    agents: [],
    transcript: {
      status: 'stopped',
      vectorStore: conversationBody.transcript?.vectorStore
    },
    scheduledTime: conversationBody.scheduledTime,
    scheduledEndTime: conversationBody.scheduledEndTime
  })
  // need to save to get id
  await conversation.save()

  for (const agentType of conversationBody.agentTypes || []) {
    let agent
    if (typeof agentType === 'string') {
      agent = await agentService.createAgent(agentType, conversation)
    } else {
      agent = await agentService.createAgent(agentType.name, conversation, agentType.properties)
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
  await transcript.loadEventMetadataIntoVectorStore(conversation)

  websocketGateway.broadcastNewConversation(conversation)

  if (conversation.scheduledTime) {
    await scheduleConversationAutoStart(conversation)
    if (conversation.scheduledEndTime) {
      await scheduleConversationAutoStop(conversation)
      await scheduleConversationEndingSoon(conversation)

    }
  } else {
    await startConversation(conversation, user)
  }
  return conversation
}

/**
 * Create a conversation from a conversation type specification
 * @param {Object} params - { type, name, platforms, topicId, properties, features, scheduledTime }
 * @param {Object} user
 * @returns {Promise<Conversation>}
 */
const createConversationFromType = async (params, user) => {
  const { type, platforms } = params

  const conversationType = getConversationType(type)
  if (!conversationType) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation type ${type} not found`)
  }

  const invalidPlatforms = platforms?.filter((p) => !conversationType.platforms.some((cp) => cp.name === p))
  if (invalidPlatforms?.length) {
    throw new ApiError(httpStatus.NOT_FOUND, `Invalid platform(s): ${invalidPlatforms.join(', ')}`)
  }

  const resolved = resolveConversationType(params, conversationType)
  return createConversation({ ...params, conversationType: type, ...resolved }, user)
}

/**
 * Update a conversation
 * @param {Object} conversationBody
 * @param {Object} user
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
  if (conversationDoc.active) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot update an active conversation')
  }

  const {
    resources: incomingResources,
    properties: incomingProperties,
    features: incomingFeatures,
    /* platforms is extracted manually so we can detect changes and recreate adapters.
       Leaving it in restBody would let updateDocument overwrite platforms directly,
       bypassing the adapter reconciliation below. */
    platforms: incomingPlatforms,
    topicId,
    type,
    ...restBody
  } = conversationBody

  const oldResources = incomingResources !== undefined ? [...conversationDoc.resources] : null

  /* updateDocument sets doc[key] = body[key] directly, so passing properties through
     would overwrite all existing keys with only what the caller sent. We merge manually
     so only the changed keys are affected. */
  if (incomingProperties !== undefined) {
    conversationDoc.properties = { ...conversationDoc.properties, ...incomingProperties }
    conversationDoc.markModified('properties') // Mongoose won't detect changes inside a Mixed field without this

    /* Adapter config fields rendered from conversation properties at creation time don't
       resync automatically when properties change later. Each adapter type declares a
       configSyncMap from conversation property keys to adapter config keys; any changed
       property that appears in a map is pushed to that type's adapter documents now. */
    for (const [adapterType, adapterDef] of Object.entries(adapterTypes)) {
      const syncMap = (adapterDef as { configSyncMap?: Record<string, string> }).configSyncMap
      if (!syncMap) continue
      const configUpdates: Record<string, unknown> = {}
      for (const [convKey, configKey] of Object.entries(syncMap)) {
        if (incomingProperties[convKey] !== undefined) {
          configUpdates[configKey] = incomingProperties[convKey]
        }
      }
      if (Object.keys(configUpdates).length > 0) {
        const adapters = await Adapter.find({ conversation: conversationDoc._id, type: adapterType })
        for (const adapter of adapters) {
          adapter.config = { ...adapter.config, ...configUpdates }
          adapter.markModified('config')
          await adapter.save()
        }
      }
    }

    /* Agents get their llmModel and llmPlatform baked in at creation time via $ref
       resolution. They don't pick up property changes automatically, so push any
       model update to Agent documents now. */
    if (incomingProperties.llmModel !== undefined) {
      /* llmModel is stored as { llmModel: string, llmPlatform: string }, an enum property
         validated by the frontend. Check both keys before writing; a malformed payload
         would otherwise null out the model on every agent. */
      const modelObj = incomingProperties.llmModel as Record<string, string>
      const { llmModel, llmPlatform } = modelObj
      if (llmModel && llmPlatform) {
        await Agent.updateMany({ conversation: conversationDoc._id }, { $set: { llmModel, llmPlatform } })
      }
    }
  }

  if (incomingFeatures !== undefined) {
    conversationDoc.features = incomingFeatures
    conversationDoc.markModified('features') // Mongoose won't detect changes inside a Mixed array without this

    /* When features change without a type change, reconcile agents to match. Type changes
       recreate all agents from scratch (see the block below), so skip this path when
       type is also changing. */
    if (type === undefined || type === conversationDoc.conversationType) {
      // conversationDoc.conversationType is always set for a persisted conversation
      const convType = conversationDoc.conversationType ? getConversationType(conversationDoc.conversationType) : null
      if (convType) {
        /* A feature is enabled if it's present in the array and its enabled flag is
           not explicitly false. */
        const enabledFeatureNames = new Set(incomingFeatures.filter((f) => f.enabled !== false).map((f) => f.name))

        for (const featureDef of convType.features ?? []) {
          for (const agentSpec of featureDef.agents ?? []) {
            if (!enabledFeatureNames.has(featureDef.name)) {
              /* Feature disabled: remove the agent document and drop the ref from
                 the conversation's agents array. */
              const agentToRemove = await Agent.findOne({
                conversation: conversationDoc._id,
                agentType: agentSpec.name
              })
              if (agentToRemove) {
                await agentToRemove.deleteOne()
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                conversationDoc.agents = (conversationDoc.agents as any[]).filter(
                  (a) => a.toString() !== agentToRemove._id.toString()
                )
              }
            } else {
              /* Feature enabled: create the agent if it doesn't exist yet. */
              const exists = await Agent.findOne({ conversation: conversationDoc._id, agentType: agentSpec.name })
              if (!exists) {
                const resolved = resolveConversationType(
                  {
                    platforms: conversationDoc.platforms,
                    properties: conversationDoc.properties,
                    features: incomingFeatures
                  },
                  convType
                )
                const agentDef = resolved.agentTypes.find((a) => a.name === agentSpec.name)
                if (agentDef) {
                  const agent = await agentService.createAgent(agentDef.name, conversationDoc, agentDef.properties)
                  /* Push the ObjectId, not the full document. conversationDoc.agents holds
                     plain refs when not populated; mixing full docs in causes type errors
                     later. */
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  conversationDoc.agents.push(agent._id as any)
                }
              }
            }
          }
        }
      }
    }
  }

  /* When platforms change without a type change, delete the existing adapters and recreate
     them for the new combination. Without this, switching from Zoom-only to Zoom+NextSpace
     keeps the old adapter config with the wrong dmChannels count. */
  if (incomingPlatforms !== undefined && (type === undefined || type === conversationDoc.conversationType)) {
    const currentSorted = (conversationDoc.platforms ?? []).slice().sort().join(',')
    const newSorted = incomingPlatforms.slice().sort().join(',')
    if (currentSorted !== newSorted) {
      await Adapter.deleteMany({ conversation: conversationDoc._id })
      conversationDoc.adapters = []

      // conversationDoc.conversationType is always set for a persisted conversation
      const convType = conversationDoc.conversationType ? getConversationType(conversationDoc.conversationType) : null
      if (convType) {
        const resolved = resolveConversationType(
          {
            platforms: incomingPlatforms,
            properties: conversationDoc.properties,
            features: incomingFeatures ?? conversationDoc.features
          },
          convType
        )
        for (const adapterProps of resolved.adapters) {
          const adapter = await adapterService.createAdapter(adapterProps, conversationDoc)
          conversationDoc.adapters.push(adapter)
        }
      }
    }
    conversationDoc.platforms = incomingPlatforms
  }

  if (topicId !== undefined) {
    const newTopic = await Topic.findById(topicId)
    if (!newTopic) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Topic not found')
    }

    /* Keep topic membership in sync on both sides. Without this, the old topic's
       conversations list would still include this event after it's been reassigned. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldTopic = conversationDoc.topic as any
    if (oldTopic?._id?.toString() !== topicId) {
      await Topic.findByIdAndUpdate(oldTopic._id, { $pull: { conversations: conversationDoc._id } })
      newTopic.conversations.push(conversationDoc.toObject())
      await newTopic.save()
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationDoc.topic = newTopic._id as any
  }

  // Agents and adapters are wired to a specific conversation type, so switching types requires recreating them.
  if (type !== undefined && type !== conversationDoc.conversationType) {
    const conversationType = getConversationType(type)
    if (!conversationType) {
      throw new ApiError(httpStatus.NOT_FOUND, `Conversation type ${type} not found`)
    }

    /* If a platform list was sent alongside the type change, use it; otherwise keep
       the existing platforms. The platform reconciliation block above is skipped when
       type is also changing, so this is the one place incomingPlatforms gets applied. */
    const effectivePlatforms = incomingPlatforms ?? conversationDoc.platforms

    /* Verify the effective platforms are supported by the new type.
       resolveConversationType silently produces no adapters for unrecognized platforms,
       so we catch this here and return a clear error instead. */
    const incompatiblePlatforms = effectivePlatforms?.filter((p) => !conversationType.platforms.some((cp) => cp.name === p))
    if (incompatiblePlatforms?.length) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Platform(s) not supported by ${type}: ${incompatiblePlatforms.join(', ')}`)
    }

    await Agent.deleteMany({ conversation: conversationDoc._id })
    await Adapter.deleteMany({ conversation: conversationDoc._id })
    conversationDoc.agents = []
    conversationDoc.adapters = []

    /* Fall back to the conversation's existing features if none were sent with this
       request. Without this, a type-only update would drop all feature-gated agents. */
    const resolved = resolveConversationType(
      {
        platforms: effectivePlatforms,
        properties: conversationDoc.properties,
        features: incomingFeatures ?? conversationDoc.features
      },
      conversationType
    )

    for (const agentType of resolved.agentTypes) {
      const agent = await agentService.createAgent(agentType.name, conversationDoc, agentType.properties)
      conversationDoc.agents.push(agent)
    }
    for (const adapterProps of resolved.adapters) {
      const adapter = await adapterService.createAdapter(adapterProps, conversationDoc)
      conversationDoc.adapters.push(adapter)
    }

    conversationDoc.conversationType = type
    if (incomingPlatforms !== undefined) {
      conversationDoc.platforms = incomingPlatforms
    }
  }

  conversationDoc = updateDocument(restBody, conversationDoc)

  if (incomingResources !== undefined) {
    const reconciled = await resourceService.updateResources(
      conversationDoc!._id!.toString(),
      oldResources,
      incomingResources
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conversationDoc!.resources = reconciled as any
  }

  await conversationDoc!.save()

  /* Reschedule auto-start and auto-stop jobs whenever the scheduled times change.
     scheduleConversationAutoStart cancels the existing job before creating the new one,
     so this is safe to call even if a job was already registered. */
  if (restBody.scheduledTime !== undefined && conversationDoc!.scheduledTime) {
    await scheduleConversationAutoStart(conversationDoc!)
  }
  if (restBody.scheduledEndTime !== undefined && conversationDoc!.scheduledEndTime) {
    await scheduleConversationAutoStop(conversationDoc!)
    await scheduleConversationEndingSoon(conversationDoc!)
  }

  await transcript.loadEventMetadataIntoVectorStore(conversationDoc!)
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
    .select(`${returnFields} resources topic`)
    .populate('agents')
    .populate('channels')
    .populate('adapters')
    .populate({ path: 'topic', select: 'name slug description owner' })
    .exec()
  if (!conversation) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${id} not found`)
  }
  const followed = (await Follower.findOne({ conversation, user }).select('_id').exec()) !== null
  const conversationPojo = conversation.toObject({
    transform: (doc, ret: ConversationDocument) => {
      // Only transform the top-level conversation document
      if (doc !== conversation) {
        return ret
      }
      const { _id, ...cleanRet } = ret
      // display channel passcodes only to conversation owner or admin user
      let { channels } = cleanRet
      if (channels && user._id.toString() !== conversation.owner.toString() && user.role !== 'admin') {
        channels = channels.map((channel) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { passcode, ...channelWithoutPasscode } = channel
          return channelWithoutPasscode
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any[]
      }
      const resources = cleanRet.resources?.map((r) => {
        /* Strip internal fileName and expose hasPdf so the client knows a PDF
           is attached without seeing the on-disk path. */
        const { _id: resourceId, fileName, ...rest } = r as unknown as Record<string, unknown>
        return { ...rest, id: (resourceId as { toString(): string }).toString(), hasPdf: !!fileName }
      })
      return {
        ...cleanRet,
        id: _id.toString(),
        followed,
        ...(channels && { channels }),
        ...(resources && { resources })
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

  try {
    await resourceService.deleteResources(conversation._id!.toString())
  } catch {
    logger.warn(`Failed to delete resources for conversation ${conversation._id}.`)
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

function validateReportType(conversation, reportName, agentType?) {
  if (reportName === 'periodicResponses') {
    const hasPeriodicAgent = conversation.agents.some((a) => a.triggers?.periodic)
    if (!hasPeriodicAgent) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Conversation has no periodic agents for periodicResponses report')
    }
  }

  if (reportName === 'directMessageResponses' || reportName === 'userMetrics') {
    const hasPerMessageAgent = conversation.agents.some((a) => a.triggers?.perMessage)
    if (!hasPerMessageAgent) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Conversation has no perMessage agents for this report type')
    }
  }

  if (reportName === 'userMetrics' && agentType) {
    const agent = conversation.agents.find((a) => a.agentType === agentType)
    if (!agent) {
      throw new ApiError(httpStatus.NOT_FOUND, `Agent '${agentType}' not found in conversation`)
    }
  }
}

const generateConversationReport = async (
  conversationId,
  reportName,
  format = 'text',
  timezone = 'UTC',
  additionalChannels: string[] = [],
  agentType?: string
) => {
  const conversation = await Conversation.findOne({ _id: conversationId })
  if (!conversation) throw new ApiError(httpStatus.NOT_FOUND, 'Conversation not found')
  if (conversation.active)
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Cannot generate a report for an active conversation. Please stop the conversation first.'
    )

  await conversation.populate('agents')

  // Validate report type matches conversation agents
  validateReportType(conversation, reportName, agentType)

  return reportService.generateReport(conversation, reportName, format, timezone, additionalChannels, agentType, {
    name: conversation.name,
    description: conversation.description,
    executedAt: conversation.endTime || conversation.startTime
  })
}

const getFeatures = async (conversationId: string) => {
  const conv = await Conversation.findOne({ _id: conversationId }).select('conversationType properties features').exec()
  if (!conv || !conv.conversationType) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation with id ${conversationId} not found`)
  }
  const convType = getConversationType(conv.conversationType)

  if (!convType || !convType.features) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Features not found for this conversation`)
  }

  // defaults to the conversation type's bot name if the conversation's bot name was not found
  const botName = conv.properties?.botName || convType.properties?.find((prop) => prop.name === 'botName')?.default

  const storedFeatures = conv.features
  const allFeatures = convType.features

  /* Merge enabled state onto every feature definition:
     - stored record present → use record.enabled (defaults to true if field absent)
     - no record → fall back to feature.default (backward compat for pre-existing conversations) */
  const featuresWithState = allFeatures.map((feature) => {
    const record = storedFeatures?.find((sf) => sf.name === feature.name)
    const enabled = record !== undefined ? record.enabled !== false : feature.default
    return { ...feature, enabled }
  })
  return {
    conversationType: conv.conversationType,
    conversationBotName: botName,
    features: featuresWithState
  }
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
  autoStart,
  autoStop,
  initializeConversations,
  joinConversation,
  generateConversationReport,
  updateTranscriptStatus,
  getFeatures
}
export default conversationService
