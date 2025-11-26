import Joi from 'joi'

const createTopic = {
  body: Joi.object().keys({
    name: Joi.string().required(),
    votingAllowed: Joi.boolean().required(),
    conversationCreationAllowed: Joi.boolean().required(),
    private: Joi.boolean().required(),
    archivable: Joi.boolean().required(),
    archiveEmail: Joi.string().allow(null, '')
  })
}
const updateTopic = {
  body: Joi.object().keys({
    id: Joi.string().required(),
    name: Joi.string(),
    slug: Joi.string(),
    votingAllowed: Joi.boolean(),
    conversationCreationAllowed: Joi.boolean(),
    private: Joi.boolean(),
    archivable: Joi.boolean(),
    archiveEmail: Joi.string().allow(null, '')
  })
}
const authenticate = {
  body: Joi.object().keys({
    passcode: Joi.number().required(),
    topicId: Joi.string().required()
  })
}
const archiveTopic = {
  body: Joi.object().keys({
    topicId: Joi.string().required(),
    token: Joi.string().required()
  })
}

const topicValidation = {
  authenticate,
  createTopic,
  updateTopic,
  archiveTopic
}
export default topicValidation
