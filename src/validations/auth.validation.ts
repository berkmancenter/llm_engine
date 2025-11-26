import Joi from 'joi'
import { password } from './custom.validation.js'

const register = {
  body: Joi.object().keys({
    username: Joi.string(),
    password: Joi.string().custom(password),
    pseudonym: Joi.string().required(),
    token: Joi.string().required(),
    email: Joi.string(),
    dataExportOptOut: Joi.boolean()
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
