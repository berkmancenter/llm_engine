import Joi from 'joi'
import { password, objectId } from './custom.validation.js'

// One (conversation, channel, passcode) triple per room a real name applies to.
// The passcode is verified server-side (userService.createUser) against that
// conversation's channel before the real-name entry is ever created — see
// authChannels, the same mechanism that already gates posting into a channel.
const realNameConversation = Joi.object().keys({
  conversationId: Joi.string().custom(objectId).required(),
  channelName: Joi.string().required(),
  passcode: Joi.string().allow('').required()
})

const register = {
  body: Joi.object().keys({
    username: Joi.string(),
    password: Joi.string().custom(password),
    pseudonym: Joi.string().required(),
    token: Joi.string().required(),
    email: Joi.string(),
    dataExportOptOut: Joi.boolean(),
    // Real name is optional; when present it must be scoped to at least one
    // conversation the caller can prove access to (see userService.createUser).
    realName: Joi.string(),
    conversations: Joi.array()
      .items(realNameConversation)
      .when('realName', { is: Joi.exist(), then: Joi.array().min(1).required() })
  })
}
const login = {
  body: Joi.object().keys({
    username: Joi.string().required(),
    password: Joi.string().required()
  })
}
const logout = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required()
  })
}
const refreshTokens = {
  body: Joi.object().keys({
    refreshToken: Joi.string().required()
  })
}
const sendPasswordReset = {
  body: Joi.object().keys({
    email: Joi.string().required()
  })
}
const resetPassword = {
  body: Joi.object().keys({
    token: Joi.string().required(),
    password: Joi.string().custom(password)
  })
}

const authValidation = {
  register,
  login,
  logout,
  refreshTokens,
  sendPasswordReset,
  resetPassword
}
export default authValidation
