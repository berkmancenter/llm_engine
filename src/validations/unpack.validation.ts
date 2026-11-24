import Joi from 'joi'
import { objectId } from './custom.validation.js'

const params = Joi.object().keys({
  conversationId: Joi.string().custom(objectId).required()
})

const selection = {
  startMessageId: Joi.string().custom(objectId).required(),
  startOffset: Joi.number().integer().min(0).required(),
  endMessageId: Joi.string().custom(objectId).required(),
  endOffset: Joi.number().integer().min(0).required(),
  transcriptPasscode: Joi.string()
}

const previewPassage = {
  params,
  body: Joi.object().keys(selection)
}

// Group Chat posts start from a Private Chat card, through sharePassage, so the participant has read it all first
const sendPassage = {
  params,
  body: Joi.object().keys({ ...selection, destination: Joi.string().valid('privateChat').required() })
}

const sharePassage = {
  params,
  body: Joi.object().keys({
    messageId: Joi.string().custom(objectId).required(),
    transcriptPasscode: Joi.string()
  })
}

const unpackValidation = { previewPassage, sendPassage, sharePassage }
export default unpackValidation
