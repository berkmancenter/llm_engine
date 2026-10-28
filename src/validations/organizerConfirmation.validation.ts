import Joi from 'joi'

const getConfirmation = {
  query: Joi.object().keys({
    token: Joi.string().required()
  })
}

const confirmOrganizer = {
  body: Joi.object().keys({
    token: Joi.string().required(),
    nonce: Joi.string().required()
  })
}

const organizerConfirmationValidation = {
  getConfirmation,
  confirmOrganizer
}
export default organizerConfirmationValidation
