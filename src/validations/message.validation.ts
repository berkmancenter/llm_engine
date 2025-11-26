import Joi from 'joi'

const createMessage = {
  body: Joi.object().keys({
    body: Joi.any().required(),
    bodyType: Joi.string().optional(),
    conversation: Joi.string().required(),
    channels: Joi.array()
      .items(Joi.object({ name: Joi.string(), passcode: Joi.string() }))
      .optional(),
    parentMessage: Joi.string().optional()
  })
}

export default createMessage
