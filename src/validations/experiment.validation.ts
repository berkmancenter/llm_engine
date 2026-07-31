import Joi from 'joi'

const agents = Joi.alternatives().try(
  Joi.object({
    agent: Joi.any().required(),
    experimentValues: Joi.object()
  }),
  Joi.object({
    agentType: Joi.string().required(),
    experimentValues: Joi.object()
  })
)

const createExperiment = {
  body: Joi.object()
    .keys({
      name: Joi.string().required(),
      baseConversation: Joi.any().required(),
      description: Joi.string(),
      agents: Joi.array().items(agents),
      executedAt: Joi.date()
    })
    .nand('agents', 'executedAt')
}

const getExperimentResults = {
  params: Joi.object().keys({
    experimentId: Joi.any().required()
  }),
  query: Joi.object().keys({
    reportName: Joi.string().required(),
    format: Joi.string().valid('text').valid('csv').default('text'),
    agent: Joi.string(),
    additionalChannels: Joi.alternatives().try(Joi.array().items(Joi.string()), Joi.string()).optional(),
    matomoSegment: Joi.string()
  })
}

const experimentValidation = {
  createExperiment,
  getExperimentResults
}
export default experimentValidation
