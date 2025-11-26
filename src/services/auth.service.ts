import httpStatus from 'http-status'
import tokenService from './token.service.js'
import userService from './user.service.js'
import Token from '../models/token.model.js'
import ApiError from '../utils/ApiError.js'
import tokenTypes from '../config/tokens.js'
import emailService from './email.service.js'
import User from '../models/user.model/user.model.js'
import logger from '../config/logger.js'
/**
 * Login with username and password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<User>}
 */
const loginUser = async (loginBody) => {
  const user = await userService.getUserByUsernamePassword(loginBody.username, loginBody.password)
  if (!user) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Incorrect username or password')
  }
  return user
}
/**
 * Logout
 * @param {string} refreshToken
 * @returns {Promise}
 */
const logout = async (refreshToken) => {
  const refreshTokenDoc = await Token.findOne({ token: refreshToken, type: tokenTypes.REFRESH, blacklisted: false })
  if (!refreshTokenDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Not found')
  }
  await refreshTokenDoc.deleteOne()
}
/**
 * Refresh auth tokens
 * @param {string} refreshToken
 * @returns {Promise<Object>}
 */
const refreshAuth = async (refreshToken) => {
  try {
    const refreshTokenDoc = await tokenService.verifyToken(refreshToken, tokenTypes.REFRESH)
    const user = await userService.getUserById(refreshTokenDoc.user)
    if (!user) {
      throw new Error()
    }
    await refreshTokenDoc.deleteOne()
    return tokenService.generateAuthTokens(user)
  } catch {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please log in')
  }
}
/**
 * Send a password reset email to user
 * @param {string} email
 * @returns {Promise}
 */
const sendPasswordReset = async (email) => {
  const user = await User.findOne({ email })
  if (!user || !user.email) {
    return
  }
  const resetToken = await tokenService.generatePasswordResetToken(user)
  emailService.sendPasswordResetEmail(user.email, resetToken, (err, info) => {
    if (err) {
      logger.error(`Error occurred sending password reset email: ${err.message}`)
      return
    }
    logger.info(`Password reset email sent successfully to ${user.email}. Response: ${info.response}`)
  })
}
/**
 * Resets a user's password
 * @param {string} email
 * @returns {Promise}
 */
const resetPassword = async (token, password) => {
  const tokenDoc = await tokenService.verifyToken(token, tokenTypes.RESET_PASSWORD)
  const user = await User.findById(tokenDoc.user)
  if (!user) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User not found')
  }
  user.password = await userService.hashPassword(password)
  await user.save()
  await Token.deleteOne({ _id: tokenDoc._id })
}

const authService = {
  loginUser,
  logout,
  refreshAuth,
  sendPasswordReset,
  resetPassword
}
export default authService
