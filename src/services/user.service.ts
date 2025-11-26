/* eslint-disable no-param-reassign */
import httpStatus from 'http-status'
import crypto from 'crypto'
import { uniqueNamesGenerator } from 'unique-names-generator'
import bcrypt from 'bcryptjs'
import { uid } from 'uid'
import { User, Message } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import { pseudonymAdjectives, pseudonymNouns } from '../config/pseudonym-dictionaries.js'
import logger from '../config/logger.js'
import config from '../config/config.js'

const tokenKey = 'greenheron'
/**
 * Hash a password
 * @param {String} password
 * @returns {Promise<String>}
 */
const hashPassword = async (password) => {
  const saltRounds = 10
  const hash = await bcrypt.hash(password, saltRounds)
  return hash
}

/**
 * Create a user
 * @param {Object} userBody
 * @returns {Promise<User>}
 */
const createUser = async (userBody) => {
  let hash
  if (userBody.password) hash = await hashPassword(userBody.password)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userProps: any = {
    username: userBody.username,
    password: hash,
    pseudonyms: [
      {
        token: userBody.token,
        pseudonym: userBody.pseudonym,
        // Mark pseudonym as active
        active: true
      }
    ]
  }

  if (userBody.email) userProps.email = userBody.email
  if (typeof userBody.dataExportOptOut !== 'undefined') {
    if (config.enableExportOptOut) {
      userProps.dataExportOptOut = userBody.dataExportOptOut
    }
  }

  const user = await User.create(userProps)
  return user
}

/**
 * Get user by username
 * @param {String} username
 * @returns {Promise<User>}
 */
const getUserByUsername = async (username) => User.findOne({ username })
/**
 * Get user by email
 * @param {String} email
 * @returns {Promise<User>}
 */
const getUserByEmail = async (email) => User.findOne({ email })
/**
 * Update a user
 * @param {Object} userBody
 * @returns {Promise<User>}
 */
const updateUser = async (userBody) => {
  const user = await User.findById(userBody.userId)
  if (!user) throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  if (userBody.username && userBody.username !== user.username) {
    const existingUser = await getUserByUsername(userBody.username)
    if (existingUser) {
      throw new ApiError(httpStatus.CONFLICT, 'Username is already registered')
    }
  }
  if (userBody.email && userBody.email !== user.email) {
    const existingUser = await getUserByEmail(userBody.email)
    if (existingUser) {
      throw new ApiError(httpStatus.CONFLICT, 'Email address is already registered')
    }
  }
  user.username = userBody.username ? userBody.username : user.username
  if (userBody.password) {
    user.password = await hashPassword(userBody.password)
  }
  user.email = userBody.email ? userBody.email : user.email
  await user.save()
  return user
}
/**
 * Add a pseudonym to an existing a user
 * @param {Object} requestBody
 * @param {Object} user
 * @returns {Promise<User>}
 */
const addPseudonym = async (requestBody, requestUser) => {
  const newPseudonym = { ...requestBody, active: true }
  const user = await User.findById(requestUser.id)
  const psuedos = user!.pseudonyms.filter((p) => !p.isDeleted)
  if (psuedos.length >= 5) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'You have reached your pseudonym limit. Delete one to add another.')
  }
  user!.pseudonyms.forEach((p) => {
    p.active = false
  })
  user!.pseudonyms.push(newPseudonym)
  await user!.save()
  return user
}
/**
 * Update a pseudonym
 * @param {Object} requestBody
 * @param {Object} user
 * @returns {Promise<User>}
 */
const activatePseudonym = async (requestBody, requestUser) => {
  const user = await User.findById(requestUser.id)
  let match = false
  user!.pseudonyms.forEach((p) => {
    p.active = false
    if (p.token === requestBody.token) {
      p.active = true
      match = true
    }
  })
  if (!match) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Pseudonym not found')
  }
  await user!.save()
  return user
}
/**
 * Delete a pseudonym
 * @param {Object} requestBody
 * @param {Object} user
 * @returns {Promise<void>}
 */
const deletePseudonym = async (pseudonymId, requestUser) => {
  // Check if pseudonym is used on any messages. If it is, then
  // soft delete it. If not, hard delete, since if can be used again.
  const user = await User.findById(requestUser.id)
  const messages = await Message.find({ pseudonymId })
  const pseudo = user!.pseudonyms.id(pseudonymId)
  if (messages.length > 0) {
    pseudo!.isDeleted = true
  } else {
    user!.pseudonyms.id(pseudonymId)!.deleteOne()
  }
  await user!.save()
}
/**
 * Query for users
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryUsers = async (filter, options) => {
  const users = await User.paginate(filter, options)
  return users
}
/**
 * Get user by id
 * @param {ObjectId} id
 * @returns {Promise<User>}
 */
const getUserById = async (id) => User.findById(id)
/**
 * Get user by username and password
 * @param {String} username
 * @param {String} password
 * @returns {Promise<User>}
 */
const getUserByUsernamePassword = async (username, password) => {
  const user = await getUserByUsername(username)
  if (user) {
    const match = await bcrypt.compare(password, user.password)
    if (match) return user
  }
  return null
}

/**
 * Update user by id
 * @param {ObjectId} userId
 * @param {Object} updateBody
 * @returns {Promise<User>}
 */
const updateUserById = async (userId, updateBody) => {
  const user = await getUserById(userId)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  if (typeof updateBody.dataExportOptOut !== 'undefined') {
    // Only allow setting dataExportOptOut if the feature is enabled
    if (config.enableExportOptOut) {
      user.dataExportOptOut = updateBody.dataExportOptOut
    }
  }
  Object.assign(user, updateBody)
  await user.save()
  return user
}
/**
 * Delete user by id
 * @param {ObjectId} userId
 * @returns {Promise<User>}
 */
const deleteUserById = async (userId) => {
  const user = await getUserById(userId)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  await user.deleteOne()
  return user
}
const newToken = () => {
  const currentDate = new Date().valueOf().toString()
  const random = Math.random().toString()
  const result = crypto
    .createHash('sha256')
    .update(currentDate + random)
    .digest('hex')
  const data = JSON.stringify({
    token: result
  })
  const algorithm = 'aes256'
  const key = tokenKey.repeat(32).substring(0, 32)
  const iv = tokenKey.repeat(16).substring(0, 16)
  const cipher = crypto.createCipheriv(algorithm, key, iv)
  const encrypted = cipher.update(data, 'utf8', 'hex') + cipher.final('hex')
  return encrypted
}
const newPseudonym = async (recursionIndex) => {
  // Get number of all possible pseudonym combinations (currently 163,564)
  // const allPseudos = pseudonymAdjectives.flatMap(d => pseudonymNouns.map(v => d + v));
  // console.log(allPseudos.length);

  let currentRecursionIndex = recursionIndex
  // If we reach the max number of possible pseudonyms, switch to random pseudonyms
  if (currentRecursionIndex === 163563) {
    logger.error('No more unique pseudonyms left to assign. Switching to truly random pseudonyms.')
    config.trulyRandomPseudonyms = 'true'
  }
  let pseudo = ''
  if (config.trulyRandomPseudonyms === 'false') {
    // Returns human friendly random pseudonym. Example: Bold Aardvark
    pseudo = uniqueNamesGenerator({ dictionaries: [pseudonymAdjectives, pseudonymNouns], length: 2 })
    pseudo = pseudo
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.substr(1).toLowerCase())
      .join(' ')
  } else {
    // Returns truly random pseudo. Example: Woodpecker_e65ddfe1d20
    pseudo = uniqueNamesGenerator({ dictionaries: [pseudonymNouns], length: 1 })
    pseudo = pseudo.charAt(0).toUpperCase() + pseudo.slice(1)
    pseudo = `${pseudo}_${uid()}`
  }
  // Check if this pseudonym has been used on messages already. If yes,
  // generate a new one via recursion, to ensure uniqueness.
  const messages = await Message.find({ pseudonym: pseudo })
  if (messages.length > 0) {
    currentRecursionIndex += 1
    return newPseudonym(currentRecursionIndex)
  }
  return pseudo
}
const isTokenGeneratedByConversations = (password) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let decryptedParsed: any = {}
  try {
    const algorithm = 'aes256'
    const key = tokenKey.repeat(32).substring(0, 32)
    const iv = tokenKey.repeat(16).substring(0, 16)
    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    const decrypted = decipher.update(password, 'hex', 'utf8') + decipher.final('utf8')
    decryptedParsed = JSON.parse(decrypted)
  } catch {
    // Todo: log error?
    throw new Error('Invalid or expired login token. Please log in again.')
  }
  return typeof decryptedParsed.token !== 'undefined'
}
/**
 * Check if a user has good "reputation"
 * @param {User} user
 * @returns {Promise<boolean>}
 */
const goodReputation = async (user) => {
  // Calculate total upvotes and downvotes for all user's messages
  const messages = await Message.find({ owner: user.id })
  let totalDownVotes = 0
  let totalUpVotes = 0
  if (messages.length > 0) {
    totalDownVotes = messages.map((m) => m.downVotes.length).reduce((x, y) => x + y)
    totalUpVotes = messages.map((m) => m.upVotes.length).reduce((x, y) => x + y)
  }
  // Subtract downvotes from upvotes for "reputation score"
  const reputationScore = totalUpVotes - totalDownVotes
  // Calculate days since account creation
  const today = new Date()
  const createdDate = new Date(user.createdAt)
  const days = Math.round((today.getTime() - createdDate.getTime()) / 86400000)
  // Good reputation is a combined total of message votes exceeding -5,
  // and an account more than 1 day old.
  return reputationScore > -5 && days >= config.DAYS_FOR_GOOD_REPUTATION
}

const userService = {
  createUser,
  updateUser,
  queryUsers,
  getUserById,
  updateUserById,
  deleteUserById,
  getUserByUsernamePassword,
  getUserByUsername,
  getUserByEmail,
  isTokenGeneratedByConversations,
  newToken,
  newPseudonym,
  goodReputation,
  addPseudonym,
  activatePseudonym,
  deletePseudonym,
  hashPassword
}
export default userService
