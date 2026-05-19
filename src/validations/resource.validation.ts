import Joi from 'joi'
import { objectId } from './custom.validation.js'

const uploadPdf = {
  params: Joi.object().keys({
    conversationId: Joi.string().custom(objectId).required(),
    resourceId: Joi.string().custom(objectId).required()
  })
}

const resourceValidation = { uploadPdf }
export default resourceValidation
