import mongoose from 'mongoose'
import httpStatus from 'http-status'
import { Conversation, Topic, Follower, Message, Channel, Agent, ConversationMembership } from '../../models/index.js'
import updateDocument from '../../utils/updateDocument.js'
import ApiError from '../../utils/ApiError.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import agentService from '../agent.service/index.js'
import Adapter from '../../models/adapter.model.js'
import schedule from '../../jobs/schedule.js'
import logger from '../../config/logger.js'
import config from '../../config/config.js'
import adapterService from '../adapter.service.js'
import channelService from '../channel.service.js'
import { ConversationDocument } from '../../models/conversation.model.js'
import { TopicDocument } from '../../models/topic.model.js'
import { getConversationType } from '../../conversations/index.js'
import adapterTypes from '../../adapters/index.js'
import resolveConversationType from '../../conversations/resolver.js'
import { supportedModels } from '../../agents/helpers/getEmbeddings.js'
import transcript from '../../agents/helpers/transcript.js'
import reportService from '../report.service.js'
import {
  doStartConversation,
  doStopConversation,
  updateTranscriptStatus,
  isConversationDraft,
  satisfiesTypeProperties
} from './lifecycle.js'
import agentDispatcher from '../../jobs/agentDispatcher.js'
import { resolveDisplayName } from '../user.service.js'
import assertMembership from '../../utils/assertMembership.js'
import resourceService from '../resource.service.js'

export { updateTranscriptStatus }

const returnFields =
  'name slug locked owner createdAt active draft conversationType platforms scheduledTime scheduledEndTime startTime endTime description moderators presenters transcript properties features'
/* A Draft conversation can no longer be edited once its scheduled start time is imminent;
   past this point the owner should create a new event rather than editing this one. */
const draftEditLockoutMs = 6 * 60 * 1000 // 6 minutes
export const maxScheduledInterval = 10 * 60 * 1000 // 10 minutes in milliseconds
export const { autoStartLeadTimeMs } = config.conversation

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
    user._id.toString() !== conversation.topic?.owner?._id.toString()
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
  if (
    user._id.toString() !== conversation.owner.toString() &&
    user._id.toString() !== conversation.topic?.owner?.toString()
  ) {
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
  const scheduledAt = new Date(conversation.scheduledTime.getTime() - autoStartLeadTimeMs)
  await schedule.autoStartConversation(scheduledAt, { conversationId: conversation._id })
  logger.debug(`Scheduled auto-start for conversation ${conversation._id} at ${scheduledAt}`)
}

async function scheduleConversationEndingSoon(conversation) {
  await schedule.cancelConversationEndingSoon(conversation._id)
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

/**
 * Create a conversation
 * @param {Object} conversationBody
 * @param {Object} user
 * @param {Object} [options]
 * @param {boolean} [options.allowDraft] trusted internal callers only; lets a conversation be created
 *   with no topic, saved as a draft for the owner to complete (see createConversationFromType)
 * @returns {Promise<Conversation>}
 */
const createConversation = async (conversationBody, user, { allowDraft = false } = {}) => {
  let topic: TopicDocument | null = null
  if (conversationBody.topicId) {
    const topicId = new mongoose.Types.ObjectId(conversationBody.topicId)
    topic = await Topic.findById(topicId)
    if (!topic) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No such topic')
    }
    if (!topic.conversationCreationAllowed && user._id.toString() !== topic.owner.toString()) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Conversation creation not allowed.')
    }
  } else if (!allowDraft) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'topic id must be passed in request body')
  }

  /* useRealNames is create-time only (see IConversation.useRealNames): an explicit value in
     the body wins, otherwise it falls back to the conversation type's own default (e.g.
     communityRoom.ts), otherwise false. updateConversation never reads this field at all, so
     it can't change after creation. */
  const conversationType = conversationBody.conversationType ? getConversationType(conversationBody.conversationType) : null
  const useRealNames = conversationBody.useRealNames ?? conversationType?.useRealNames ?? false
  const enforceMembership = conversationBody.enforceMembership ?? conversationType?.enforceMembership ?? false

  if (conversationBody.scheduledTime && new Date(conversationBody.scheduledTime) <= new Date()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'scheduledTime must be in the future')
  }

  const { embeddingsPlatform, embeddingsModelName } = conversationBody.transcript?.vectorStore ?? {}
  if (embeddingsPlatform || embeddingsModelName) {
    if (!supportedModels.find((m) => embeddingsPlatform === m.platform && embeddingsModelName === m.model))
      throw new Error('No such supported embedding model')
  }

  /* Trusted-caller-only, same as allowDraft itself: the public routes never pass allowDraft:true,
     so a client can never write source on a conversation it creates. Without this gate, an
     ordinary user could squat on a future invite's or email's dedup key via the public API and
     make a legitimate one silently no-op against their decoy (see createConversationFromInvite
     and createConversationFromEmail, which both dedup by reading source back). The allowlist
     itself, not just allowDraft, still applies: an allowDraft caller can only ever write these
     two known keys, never an arbitrary one. */
  const ALLOWED_SOURCE_KEYS = ['inviteUid', 'messageId']
  const allowedSource = allowDraft
    ? Object.fromEntries(Object.entries(conversationBody.source ?? {}).filter(([key]) => ALLOWED_SOURCE_KEYS.includes(key)))
    : {}

  const conversation = new Conversation({
    name: conversationBody.name,
    owner: user,
    ...(topic && { topic }),
    ...(Object.keys(allowedSource).length > 0 && { source: allowedSource }),
    enableAgents: !!conversationBody.agentTypes?.length,
    useRealNames,
    enforceMembership,
    ...(conversationBody.enableDMs !== undefined && { enableDMs: conversationBody.enableDMs }),
    ...(conversationBody.conversationType !== undefined && { conversationType: conversationBody.conversationType }),
    ...(conversationBody.platforms !== undefined && { platforms: conversationBody.platforms }),
    ...(conversationBody.description !== undefined && { description: conversationBody.description }),
    ...(conversationBody.moderators !== undefined && { moderators: conversationBody.moderators }),
    ...(conversationBody.presenters !== undefined && { presenters: conversationBody.presenters }),
    ...(conversationBody.properties !== undefined && { properties: conversationBody.properties }),
    ...(conversationBody.analyticsRefs !== undefined && { analyticsRefs: conversationBody.analyticsRefs }),
    ...(conversationBody.features !== undefined && { features: conversationBody.features }),
    ...(conversationBody.goals !== undefined && { goals: conversationBody.goals }),
    ...(conversationBody.behaviorPolicy !== undefined && { behaviorPolicy: conversationBody.behaviorPolicy }),
    ...(conversationBody.resources !== undefined && { resources: conversationBody.resources }),
    agents: [],
    transcript: {
      status: 'stopped',
      vectorStore: conversationBody.transcript?.vectorStore
    },
    scheduledTime: conversationBody.scheduledTime,
    scheduledEndTime: conversationBody.scheduledEndTime
  })
  conversation.draft = isConversationDraft(conversation)
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

  /* allowDraft relaxes the property check, so a draft conversation can be missing a property an
     adapter's config depends on (e.g. a Zoom event with no zoomMeetingUrl yet). Adapter config is
     rendered from a template and saved independently, so an adapter built from a missing property
     would save with an empty required field and fail its own validation. satisfiesTypeProperties
     checks only conversation properties (never topic or scheduledEndTime, see resolver.ts's
     resolvePropertyReferences, which never receives either), so a conversation that's draft for
     one of those unrelated reasons still gets its adapters created here; updateConversation's
     backfill block creates them once a still-missing property arrives. */
  if (satisfiesTypeProperties(conversation)) {
    for (const adapterProps of conversationBody.adapters || []) {
      const adapter = await adapterService.createAdapter(adapterProps, conversation)
      conversation.adapters.push(adapter)
    }
  }

  for (const channelProps of conversationBody.channels || []) {
    await channelService.createChannel(conversation, channelProps)
  }

  // A topicless draft has nothing to link back to, so only touch the topic when one resolved.
  if (topic) {
    topic.conversations.push(conversation.toObject())
    await Promise.all([conversation.save(), topic.save()])
  } else {
    await conversation.save()
  }
  await transcript.loadEventMetadataIntoVectorStore(conversation)

  websocketGateway.broadcastNewConversation(conversation)

  if (conversation.scheduledTime) {
    await scheduleConversationAutoStart(conversation)
    if (conversation.scheduledEndTime) {
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
/* allowDraft comes from trusted internal callers only. The email webhook passes it so an
   incomplete invite resolves into a draft instead of a 400; the HTTP route omits it, so
   form submissions stay strict. */
const createConversationFromType = async (params, user, { allowDraft = false } = {}) => {
  const { type, platforms } = params

  const conversationType = getConversationType(type)
  if (!conversationType) {
    throw new ApiError(httpStatus.NOT_FOUND, `Conversation type ${type} not found`)
  }

  const invalidPlatforms = platforms?.filter((p) => !conversationType.platforms.some((cp) => cp.name === p))
  if (invalidPlatforms?.length) {
    throw new ApiError(httpStatus.NOT_FOUND, `Invalid platform(s): ${invalidPlatforms.join(', ')}`)
  }

  const resolved = resolveConversationType(params, conversationType, allowDraft)
  return createConversation({ ...params, conversationType: type, ...resolved }, user, { allowDraft })
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
    user.role !== 'admin' &&
    user._id.toString() !== conversationDoc.owner.toString() &&
    user._id.toString() !== conversationDoc.topic?.owner?.toString()
  ) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Only conversation or topic owner can update.')
  }
  if (conversationDoc.active) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot update an active conversation')
  }
  /* Once a Draft conversation's scheduled start time is within 6 minutes (including
     after it has already passed), it stays locked from further edits: the owner
     should create a new event rather than editing this one. Non-Draft conversations
     aren't subject to this: they're already separately blocked from updates once
     active by the guard above. */
  if (
    conversationDoc.draft &&
    conversationDoc.scheduledTime &&
    Date.now() >= conversationDoc.scheduledTime.getTime() - draftEditLockoutMs
  ) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'This draft event is too close to its scheduled start time to edit. Please create a new event instead.'
    )
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
    // draft is server-computed (see recompute below); never let the client set it directly.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    draft: _incomingDraft,
    // useRealNames and enforceMembership are create-time only; update never touches them.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    useRealNames: _incomingUseRealNames,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    enforceMembership: _incomingEnforcesMembership,
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
       conversations list would still include this event after it's been reassigned.
       oldTopic is undefined for a conversation that never had one, e.g. an invite-created
       draft with no matching Topic at creation time (see emailSetup.service's resolveTopic),
       so there is nothing to pull it from in that case. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldTopic = conversationDoc.topic as any
    if (oldTopic?._id?.toString() !== topicId) {
      if (oldTopic?._id) {
        await Topic.findByIdAndUpdate(oldTopic._id, { $pull: { conversations: conversationDoc._id } })
      }
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

  /* Whatever changed above (a property, the topic, ...) may have made an adapter that was
     deferred at creation time (see createConversation's satisfiesTypeProperties guard) safe to
     create now. This runs on every update, not just ones that flip overall draft status: an
     adapter only depends on conversation properties, never on topic or scheduledEndTime, so it
     can become ready well before the conversation as a whole is no longer Draft. The existence
     check makes this a no-op on every update that doesn't need it. */
  const conversationType = conversationDoc!.conversationType ? getConversationType(conversationDoc!.conversationType) : null
  if (conversationType && satisfiesTypeProperties(conversationDoc!)) {
    const resolved = resolveConversationType(
      {
        platforms: conversationDoc!.platforms,
        properties: conversationDoc!.properties,
        features: incomingFeatures ?? conversationDoc!.features
      },
      conversationType
    )
    for (const adapterProps of resolved.adapters) {
      const adapterType = (adapterProps as { type?: string }).type
      const exists = await Adapter.findOne({ conversation: conversationDoc!._id, type: adapterType })
      if (!exists) {
        const adapter = await adapterService.createAdapter(adapterProps, conversationDoc!)
        conversationDoc!.adapters.push(adapter)
      }
    }
  }

  conversationDoc!.draft = isConversationDraft(conversationDoc!)

  await conversationDoc!.save()

  /* Reschedule auto-start and auto-stop jobs whenever the scheduled times change.
     scheduleConversationAutoStart cancels the existing job before creating the new one,
     so this is safe to call even if a job was already registered. */
  if (restBody.scheduledTime !== undefined && conversationDoc!.scheduledTime) {
    await scheduleConversationAutoStart(conversationDoc!)
  }
  if (restBody.scheduledEndTime !== undefined && conversationDoc!.scheduledEndTime) {
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
    .populate({ path: 'topic', select: 'name slug description owner private' })
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
      const isOwnerOrAdmin = user._id.toString() === conversation.owner.toString() || user.role === 'admin'

      // display channel passcodes only to conversation owner or admin user
      let { channels } = cleanRet
      if (channels && !isOwnerOrAdmin) {
        channels = channels.map((channel) => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { passcode, ...channelWithoutPasscode } = channel
          return channelWithoutPasscode
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any[]
      }

      // strip agentConfig and adapter config from non-owners — these may contain API keys
      let { agents, adapters } = cleanRet
      if (!isOwnerOrAdmin) {
        if (agents) {
          agents = agents.map(({ agentConfig, ...rest }) => {
            // Clients need the bot's name to label the chat, so it is the one key that survives.
            const botName = agentConfig?.botName
            return typeof botName === 'string' && botName !== '' ? { ...rest, agentConfig: { botName } } : rest
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any[]
        }
        if (adapters) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
          adapters = adapters.map(({ config: _config, ...rest }) => rest) as any[]
        }
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
        ...(agents && { agents }),
        ...(adapters && { adapters }),
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
  if (
    user._id.toString() !== conversation.owner.toString() &&
    user._id.toString() !== conversation.topic?.owner?.toString()
  ) {
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
  if (
    user._id.toString() !== conversation.owner.toString() &&
    user._id.toString() !== conversation.topic?.owner?.toString()
  ) {
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
      .select('enableDMs agents channels topic useRealNames enforceMembership')

    if (!conversation) {
      throw new ApiError(httpStatus.NOT_FOUND, `Conversation with ID ${conversationOrId} not found`)
    }
  }
  await assertMembership(user, conversation)
  if (!conversation.enableDMs.includes('agents')) {
    return conversation
  }
  await conversation.populate(['channels', 'agents', { path: 'topic', select: 'private' }])

  let firstJoin = false
  for (const agent of conversation.agents) {
    const directChannelName = `direct-${user._id}-${agent._id}`
    if (!conversation.channels?.find((channel) => channel.name === directChannelName)) {
      await channelService.createChannel(conversation, {
        name: directChannelName,
        direct: true,
        participants: [user, agent],
        passcode: null
      })
      firstJoin = true
    }
  }

  if (firstJoin) {
    const conversationId = conversation._id.toString()
    const topicId = conversation.topic?._id?.toString() ?? conversation.topic?.toString()
    const topicIsPrivate = (conversation.topic as TopicDocument | null)?.private ?? true
    const name = resolveDisplayName(user, conversation).pseudonym
    if (user.email) {
      await ConversationMembership.updateOne(
        { conversation: conversation._id, email: user.email },
        { $set: { joined: true } }
      )
    }
    await agentDispatcher.dispatch(
      {
        type: 'participantJoined',
        conversationId,
        userId: user._id.toString(),
        name,
        bio: user.bio,
        interests: user.interests
      },
      { type: 'conversation', id: conversationId, topicId, topicIsPrivate }
    )
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
  joinConversation,
  generateConversationReport,
  updateTranscriptStatus,
  getFeatures
}
export default conversationService
