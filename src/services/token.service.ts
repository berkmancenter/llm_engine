import jwt from 'jsonwebtoken'
import moment from 'moment'
import config from '../config/config.js'
import { Token } from '../models/index.js'
import tokenTypes from '../config/tokens.js'
/**
 * Generate token
 * @param {ObjectId} userId
 * @param {Moment} expires
 * @param {string} type
 * @param {string} [secret]
 * @returns {string}
 */
const generateToken = (userId, expires, type, secret = config.jwt.secret) => {
  const payload = {
    sub: userId,
    iat: moment().unix(),
    exp: expires.unix(),
    type
  }
  return jwt.sign(payload, secret)
}
/**
 * Save a token
 * @param {string} token
 * @param {ObjectId} userId
 * @param {Moment} expires
 * @param {string} type
 * @param {boolean} [blacklisted]
 * @returns {Promise<Token>}
 */
const saveToken = async (token, userId, expires, type, blacklisted = false) => {
  const tokenDoc = await Token.create({
    token,
    user: userId,
    expires: expires.toDate(),
    type,
    blacklisted
  })
  return tokenDoc
}
/**
 * Verify token and return token doc (or throw an error if it is not valid)
 * @param {string} token
 * @param {string} type
 * @returns {Promise<Token>}
 */
const verifyToken = async (token, type) => {
  const payload = jwt.verify(token, config.jwt.secret)
  const tokenDoc = await Token.findOne({ token, type, user: payload.sub, blacklisted: false })
  if (!tokenDoc) {
    throw new Error('Token not found')
  }
  return tokenDoc
}
/**
 * Generate auth tokens
 * @param {User} user
 * @returns {Promise<Object>}
 */
const generateAuthTokens = async (user) => {
  const accessTokenExpires = moment().add(config.jwt.accessExpirationMinutes, 'minutes')
  const accessToken = generateToken(user.id, accessTokenExpires, tokenTypes.ACCESS)
  const refreshTokenExpires = moment().add(config.jwt.refreshExpirationDays, 'days')
  const refreshToken = generateToken(user.id, refreshTokenExpires, tokenTypes.REFRESH)
  await saveToken(refreshToken, user.id, refreshTokenExpires, tokenTypes.REFRESH)
  return {
    access: {
      token: accessToken,
      expires: accessTokenExpires.toDate()
    },
    refresh: {
      token: refreshToken,
      expires: refreshTokenExpires.toDate()
    }
  }
}
/**
 * Generate verify email token
 * @param {User} user
 * @returns {Promise<string>}
 */
const generateVerifyEmailToken = async (user) => {
  const expires = moment().add(config.jwt.verifyEmailExpirationMinutes, 'minutes')
  const verifyEmailToken = generateToken(user.id, expires, tokenTypes.VERIFY_EMAIL)
  await saveToken(verifyEmailToken, user.id, expires, tokenTypes.VERIFY_EMAIL)
  return verifyEmailToken
}
/**
 * Generate password reset token
 * @param {User} user
 * @returns {Promise<string>}
 */
const generatePasswordResetToken = async (user) => {
  const expires = moment().add(config.jwt.resetPasswordExpirationMinutes, 'minutes')
  const resetToken = generateToken(user.id, expires, tokenTypes.RESET_PASSWORD)
  await saveToken(resetToken, user.id, expires, tokenTypes.RESET_PASSWORD)
  return resetToken
}
/**
 * Generate archive topic token
 * @param {User} user
 * @returns {Promise<string>}
 */
const generateArchiveTopicToken = async (user) => {
  const expires = moment().add(7, 'days')
  const archiveTopicToken = await generateToken(user.id, expires, tokenTypes.ARCHIVE_TOPIC)
  await saveToken(archiveTopicToken, user.id, expires, tokenTypes.ARCHIVE_TOPIC)
  return archiveTopicToken
}

const tokenService = {
  generateToken,
  saveToken,
  verifyToken,
  generateAuthTokens,
  generateVerifyEmailToken,
  generateArchiveTopicToken,
  generatePasswordResetToken
}
export default tokenService
