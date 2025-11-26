import Joi from 'joi'

const agentModifications = {
  agent: Joi.any().required(),
  experimentValues: Joi.object(),
  simulatedStartTime: Joi.date()
}
const createExperiment = {
  body: Joi.object().keys({
    name: Joi.string().required(),
    baseConversation: Joi.any().required(),
    description: Joi.string(),
    agentModifications: Joi.array().items(Joi.object(agentModifications)),
    executedAt: Joi.date()
  })
}

const getExperimentResults = {
  params: Joi.object().keys({
    experimentId: Joi.any().required()
  }),
  query: Joi.object().keys({
    reportName: Joi.string().required(),
    format: Joi.string().valid('text').default('text')
  })
}

const experimentValidation = {
  createExperiment,
  getExperimentResults
}
export default experimentValidation
