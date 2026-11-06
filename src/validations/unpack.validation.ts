import Joi from 'joi'
import { objectId } from './custom.validation.js'

const params = Joi.object().keys({
  conversationId: Joi.string().custom(objectId).required()
})

const selection = {
  startMessageId: Joi.string().custom(objectId).required(),
  startOffset: Joi.number().integer().min(0).required(),
  endMessageId: Joi.string().custom(objectId).required(),
  endOffset: Joi.number().integer().min(0).required()
}

const previewPassage = {
  params,
  body: Joi.object().keys(selection)
}

// Group Chat arrives in a later release; until then only Private Chat is accepted
const sendPassage = {
  params,
  body: Joi.object().keys({ ...selection, destination: Joi.string().valid('privateChat').required() })
}

const unpackValidation = { previewPassage, sendPassage }
export default unpackValidation
