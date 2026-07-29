import Joi from 'joi'
import { listGoalIds } from '../goals/loader.js'

// Validated against the known goal ids so a typo rejects with a clear 400 instead of
// silently disabling every goal — getEligibleGoals fails closed (returns []) when any
// id in the array doesn't resolve.
const goalsSchema = Joi.array().items(Joi.string().valid(...listGoalIds()))

const resourceSchema = Joi.object().keys({
  source: Joi.string().valid('speaker', 'ai').required(),
  category: Joi.string().valid('required', 'referenced', 'suggested').required(),
  title: Joi.string().required(),
  authors: Joi.array().items(Joi.string()).allow(null),
  year: Joi.string().allow('', null),
  url: Joi.string().allow('', null),
  citation: Joi.string().allow('', null),
  description: Joi.string().allow('', null),
  summary: Joi.string().allow('', null),
  relevanceReason: Joi.string().allow('', null),
  participantVisible: Joi.boolean()
})

const updateResourceSchema = resourceSchema.keys({
  id: Joi.string().optional()
})

const updateConversation = {
  body: Joi.object().keys({
    id: Joi.string().required(),
    name: Joi.string(),
    locked: Joi.boolean(),
    description: Joi.string().allow('', null),
    scheduledTime: Joi.date(),
    scheduledEndTime: Joi.date(),
    topicId: Joi.string(),
    type: Joi.string(),
    platforms: Joi.array().items(Joi.string()),
    properties: Joi.object(),
    features: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        enabled: Joi.boolean(),
        config: Joi.object()
      })
    ),
    moderators: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null),
        alternateName: Joi.string().allow('', null)
      })
    ),
    presenters: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null),
        alternateName: Joi.string().allow('', null)
      })
    ),
    resources: Joi.array().items(updateResourceSchema),
    analyticsRefs: Joi.object().pattern(Joi.string(), Joi.string()),
    goals: goalsSchema
  })
}

const createConversation = {
  body: Joi.object().keys({
    name: Joi.string(),
    topicId: Joi.string().required(),
    scheduledTime: Joi.date(),
    scheduledEndTime: Joi.date(),
    channels: Joi.any(),
    agentTypes: Joi.any(),
    transcript: Joi.object(),
    platforms: Joi.array().items(Joi.string()),
    description: Joi.string(),
    moderators: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null),
        alternateName: Joi.string().allow('', null)
      })
    ),
    presenters: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null),
        alternateName: Joi.string().allow('', null)
      })
    ),
    resources: Joi.array().items(resourceSchema),
    // Opt the event into analytics sources by name, each with that source's ref
    // (e.g. { matomo: 'dimension7' }). Stored opaquely; each adapter interprets its own ref.
    analyticsRefs: Joi.object().pattern(Joi.string(), Joi.string())
  })
}
const agentAllowedProperties = {
  agentConfig: Joi.any(),
  llmTemplates: Joi.object(),
  llmModel: Joi.string(),
  llmPlatform: Joi.string(),
  llmModelOptions: Joi.object(),
  triggers: Joi.object()
}
// only certain props can be patched
const patchConversationAgent = {
  body: Joi.object().keys(agentAllowedProperties)
}

const getConversationReport = {
  params: Joi.object().keys({
    conversationId: Joi.any().required()
  }),
  query: Joi.object().keys({
    reportName: Joi.string().valid('periodicResponses', 'directMessageResponses', 'userMetrics').required(),
    format: Joi.string().valid('text', 'csv').default('text'),
    agent: Joi.string(),
    additionalChannels: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()).optional()
  })
}

const conversationValidation = {
  createConversation,
  updateConversation,
  patchConversationAgent,
  getConversationReport
}
export default conversationValidation
