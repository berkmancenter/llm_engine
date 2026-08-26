import Joi from 'joi'
import { objectId } from './custom.validation.js'

const importMembers = {
  params: Joi.object().keys({
    conversationId: Joi.string().custom(objectId).required()
  })
}

const memberValidation = { importMembers }
export default memberValidation
