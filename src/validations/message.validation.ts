import Joi from 'joi'
import { MODERATION_REASONS, MODERATION_REASON_MAX_LENGTH } from '../models/moderationEvent.model.js'
import { objectId } from './custom.validation.js'

const createMessage = {
  body: Joi.object().keys({
    body: Joi.any().required(),
    bodyType: Joi.string().optional(),
    conversation: Joi.string().required(),
    channels: Joi.array()
      .items(Joi.object({ name: Joi.string(), passcode: Joi.string() }))
      .optional(),
    parentMessage: Joi.string().optional(),
    answersPrompt: Joi.string().optional()
  })
}

const hideReason = Joi.string().valid(...MODERATION_REASONS)
// unhide accepts one of the same reasons or a short free-text note
const unhideReason = Joi.string().trim().max(MODERATION_REASON_MAX_LENGTH)

const hideMessage = {
  params: Joi.object().keys({
    messageId: Joi.string().custom(objectId).required()
  }),
  body: Joi.object().keys({ reason: hideReason })
}
const unhideMessage = {
  params: hideMessage.params,
  body: Joi.object().keys({ reason: unhideReason })
}

const hideUserMessages = {
  params: Joi.object().keys({
    conversationId: Joi.string().custom(objectId).required(),
    userId: Joi.string().custom(objectId).required()
  }),
  body: Joi.object().keys({ reason: hideReason })
}
const unhideUserMessages = {
  params: hideUserMessages.params,
  body: Joi.object().keys({ reason: unhideReason })
}

const listModerationEvents = {
  params: Joi.object().keys({
    conversationId: Joi.string().custom(objectId).required()
  }),
  query: Joi.object().keys({
    limit: Joi.number().integer().min(1).max(100),
    page: Joi.number().integer().min(1)
  })
}

export { hideMessage, unhideMessage, hideUserMessages, unhideUserMessages, listModerationEvents }
export default createMessage
