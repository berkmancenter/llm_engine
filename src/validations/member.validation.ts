import Joi from 'joi'
import { objectId } from './custom.validation.js'

const importMembers = {
  params: Joi.object().keys({
    conversationId: Joi.string().custom(objectId).required()
  })
}

const sendInvites = {
  params: Joi.object().keys({
    conversationId: Joi.string().custom(objectId).required()
  })
}

const resendInvite = {
  params: Joi.object().keys({
    membershipId: Joi.string().custom(objectId).required()
  })
}

const memberValidation = { importMembers, sendInvites, resendInvite }
export default memberValidation
