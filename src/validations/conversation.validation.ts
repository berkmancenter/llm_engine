import Joi from 'joi'

const updateConversation = {
  body: Joi.object().keys({
    id: Joi.string().required(),
    name: Joi.string(),
    locked: Joi.boolean(),
    description: Joi.string(),
    moderators: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null)
      })
    ),
    presenters: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null)
      })
    )
  })
}

const createConversation = {
  body: Joi.object().keys({
    name: Joi.string(),
    topicId: Joi.string().required(),
    scheduledTime: Joi.date(),
    channels: Joi.any(),
    agentTypes: Joi.any(),
    transcript: Joi.object(),
    platforms: Joi.array().items(Joi.string()),
    description: Joi.string(),
    moderators: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null)
      })
    ),
    presenters: Joi.array().items(
      Joi.object().keys({
        name: Joi.string().required(),
        bio: Joi.string().allow('', null)
      })
    )
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
