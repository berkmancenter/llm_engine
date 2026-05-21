import Joi from 'joi'

const MAX_DESCRIPTION_LENGTH = 4000

const plan = {
  body: Joi.object().keys({
    description: Joi.string().min(1).max(MAX_DESCRIPTION_LENGTH).required()
  })
}

export default { plan }
