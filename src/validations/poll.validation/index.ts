import Joi from 'joi'

const createPoll = {
  body: Joi.object().keys({
    title: Joi.string().required(),
    description: Joi.string(),
    locked: Joi.boolean(),
    owner: Joi.string(),
    threshold: Joi.number().min(1),
    expirationDate: Joi.date(),
    topicId: Joi.string().required(),
    multiSelect: Joi.boolean(),
    allowNewChoices: Joi.boolean(),
    choicesVisible: Joi.boolean(),
    responseCountsVisible: Joi.boolean(),
    onlyOwnChoicesVisible: Joi.boolean(),
    whenResultsVisible: Joi.string(),
    responsesVisibleToNonParticipants: Joi.boolean(),
    responsesVisible: Joi.boolean(),
    choices: Joi.array().items(Joi.object().keys({ text: Joi.string().required() }))
  })
}
const respondPoll = {
  body: Joi.object().keys({
    choice: Joi.object().keys({
      text: Joi.string().required(),
      remove: Joi.boolean()
    }),
    topicId: Joi.string().required()
  })
}

const pollValidation = { createPoll, respondPoll }
export default pollValidation
