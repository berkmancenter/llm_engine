/* eslint-disable no-param-reassign */
import httpStatus from 'http-status'
import crypto from 'crypto'
import { uniqueNamesGenerator } from 'unique-names-generator'
import bcrypt from 'bcryptjs'
import { uid } from 'uid'
import { User, Message, RealNameAudit, RealNameRegistry } from '../models/index.js'
import ApiError from '../utils/ApiError.js'
import { pseudonymAdjectives, pseudonymNouns } from '../config/pseudonym-dictionaries.js'
import logger from '../config/logger.js'
import config from '../config/config.js'
import { getModelChat, coreLLMPlatform, coreLLMModel } from '../agents/helpers/getModelChat.js'
import { getChatPromptResponse } from '../agents/helpers/llmChain.js'
import authChannels from '../utils/authChannels.js'

const funFactSystemTemplate = `You create short, fun facts about pseudonyms. The pseudonym is in the form "adjective noun". Create a 1 sentence fun fact that is factual about the noun, but can be playful about the adjective part. Makes sure your answers are safe for work.
Output only the fun fact sentence itself — no headings, labels, pseudonym names, or additional commentary.`

const funFactUserTemplate = 'Create a fun fact about the pseudonym: {pseudonym}'

// Skip fun fact generation when truly random pseudonyms are enabled — those aren't human-readable.
const generatePseudonymFunFact = async (pseudonym: string) => {
  if (config.trulyRandomPseudonyms === 'true') {
    return null
  }
  try {
    const llm = await getModelChat(coreLLMPlatform, coreLLMModel)
    return (await getChatPromptResponse(llm, funFactSystemTemplate, funFactUserTemplate, { pseudonym })) as string
  } catch (err) {
    logger.warn(`Failed to generate fun fact for pseudonym "${pseudonym}": ${err.message}`)
    return null
  }
}

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

// Trim/collapse-whitespace/lower-case a real name for comparison and storage in
// normalizedPseudonym, so "Jane Doe" and "jane  doe" are recognized as the same
// person instead of coexisting as two roster rows for one conversation.
const normalizeRealName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase()

const DUPLICATE_KEY_ERROR_CODE = 11000

// Atomically reserves (conversationId, name) in RealNameRegistry — the insert IS the
// uniqueness check, enforced by that collection's compound unique index, not a
// separate check-then-write. Returns the reservation on success, or null if that
// name is already taken in this conversation. Scoped per conversation, deliberately
// — the same real name is fine in two different rooms; it's only a conflict within
// the same one.
const reserveRealName = async (name: string, conversationId: string) => {
  try {
    return await RealNameRegistry.create({ conversationId, normalizedPseudonym: normalizeRealName(name) })
  } catch (err) {
    if (err.code === DUPLICATE_KEY_ERROR_CODE) return null
    throw err
  }
}

// Audit trail for real-name entries — id/action only, never the name text itself
// (see ApiError messages and log lines throughout this file: none of them echo a
// real name back). Best-effort: a failure to record shouldn't block the request.
// userId is undefined for a rejection that happens before an account exists yet
// (a failed passcode or uniqueness check during registration).
const recordRealNameAudit = async (userId, conversationId, action): Promise<void> => {
  try {
    await RealNameAudit.create({ userId, conversationId, action })
  } catch (err) {
    logger.warn(`Failed to record real-name audit entry (action: ${action}): ${err.message}`)
  }
}

// Verifies the caller actually has access to every conversation a real name is
// being scoped to, via the same channel-passcode mechanism that already gates
// posting into a channel (authChannels) — never trust a bare client-supplied
// conversation id. Throws a generic ApiError (no specifics about which
// conversation/channel failed) on the first failure.
const verifyRealNameConversationAccess = async (conversations): Promise<void> => {
  for (const { conversationId, channelName, passcode } of conversations) {
    try {
      await authChannels([{ name: channelName, passcode }], conversationId)
    } catch {
      await recordRealNameAudit(undefined, conversationId, 'passcode_rejected')
      throw new ApiError(httpStatus.FORBIDDEN, 'Could not verify access to one or more conversations.')
    }
  }
}

/**
 * Create a user
 *
 * When `userBody.realName` is present, also creates a real-name pseudonym entry
 * (isRealName: true) scoped to `userBody.conversations`, guarded end to end:
 * access to each conversation is proved via its channel passcode
 * (verifyRealNameConversationAccess/authChannels) before anything is written, the
 * name is reserved per-conversation through RealNameRegistry's unique index (atomic,
 * race-free — see reserveRealName), the entry is always created `active: false` and
 * is never handed to generatePseudonymFunFact (real names never reach the LLM), and
 * every rejection/creation is recorded via recordRealNameAudit (id/action only,
 * never the name text). See activatePseudonym/deletePseudonym for the matching
 * can-never-activate/can-never-delete guarantees once the entry exists.
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

  let realNameConversations
  let reservations
  if (userBody.realName) {
    realNameConversations = userBody.conversations
    await verifyRealNameConversationAccess(realNameConversations)

    // Reserve the name in every target conversation before creating anything else.
    // Each reservation is one atomic insert against RealNameRegistry's compound
    // unique index — if any conversation's name is already taken, roll back the
    // reservations this attempt already made and reject the whole registration.
    reservations = []
    for (const { conversationId } of realNameConversations) {
      const reservation = await reserveRealName(userBody.realName, conversationId)
      if (!reservation) {
        await RealNameRegistry.deleteMany({ _id: { $in: reservations.map((r) => r._id) } })
        await recordRealNameAudit(undefined, conversationId, 'uniqueness_rejected')
        throw new ApiError(httpStatus.CONFLICT, 'That name is already registered for one of these conversations.')
      }
      reservations.push(reservation)
    }

    userProps.pseudonyms.push({
      token: newToken(),
      pseudonym: userBody.realName,
      normalizedPseudonym: normalizeRealName(userBody.realName),
      // Never active — a real name can never be the pseudonym stamped on a message.
      active: false,
      isRealName: true,
      conversations: realNameConversations.map(({ conversationId }) => conversationId)
    })
  }

  const user = await User.create(userProps)
  // Fun facts are a pseudonym-flavor feature and must never send a real name to an
  // LLM — only ever generated for pseudonyms[0], the always-present ordinary entry.
  const funFact = await generatePseudonymFunFact(user.pseudonyms[0].pseudonym)
  if (funFact) {
    user.pseudonyms[0].funFact = funFact
    await user.save()
  }
  if (reservations?.length) {
    // Attach the now-known userId to the reservations made above, and audit the
    // successful creation (id/action only — never the name text, see recordRealNameAudit).
    await RealNameRegistry.updateMany({ _id: { $in: reservations.map((r) => r._id) } }, { userId: user._id })
    await Promise.all(
      realNameConversations.map(({ conversationId }) => recordRealNameAudit(user._id, conversationId, 'created'))
    )
  }
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
 *
 * Ordinary pseudonyms only — a real name can only ever be created at registration
 * (see createUser), never through this endpoint, so requestBody is copied field by
 * field rather than spread, and the pseudonym cap below excludes any isRealName
 * entries the account may already have.
 * @param {Object} requestBody
 * @param {Object} user
 * @returns {Promise<User>}
 */
const addPseudonym = async (requestBody, requestUser) => {
  // Whitelisted explicitly, never a spread of requestBody — this endpoint only ever
  // creates ordinary pseudonyms; a real name is only ever created at registration
  // (see createUser), and isRealName/conversations must never be reachable here.
  const newPseudonym = { pseudonym: requestBody.pseudonym, token: requestBody.token, active: true }
  const user = await User.findById(requestUser.id)
  const psuedos = user!.pseudonyms.filter((p) => !p.isDeleted && !p.isRealName)
  if (psuedos.length >= 5) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'You have reached your pseudonym limit. Delete one to add another.')
  }
  user!.pseudonyms.forEach((p) => {
    p.active = false
  })
  user!.pseudonyms.push(newPseudonym)
  await user!.save()
  const addedPseudo = user!.pseudonyms[user!.pseudonyms.length - 1]
  const funFact = await generatePseudonymFunFact(addedPseudo.pseudonym)
  if (funFact) {
    addedPseudo.funFact = funFact
    await user!.save()
  }
  return user
}
/**
 * Update a pseudonym
 *
 * A real-name entry (isRealName: true) can never be activated — see IPseudonym.
 * This is the guard that keeps a real name from ever becoming the pseudonym
 * message.service.ts stamps on a message; userSchema's pre('save') hook
 * (user.model.ts) backs it up in case some other code path ever sets
 * `active = true` directly.
 * @param {Object} requestBody
 * @param {Object} user
 * @returns {Promise<User>}
 */
const activatePseudonym = async (requestBody, requestUser) => {
  const user = await User.findById(requestUser.id)
  // Look up the target and bail before mutating anything — the old implementation
  // flipped every pseudonym's `active` as it went, including the target, so a
  // rejected activation would still have deactivated the user's current pseudonym
  // as a side effect.
  const target = user!.pseudonyms.find((p) => p.token === requestBody.token)
  if (!target) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Pseudonym not found')
  }
  if (target.isRealName) {
    await Promise.all(
      target.conversations.map((conversationId) => recordRealNameAudit(user!.id, conversationId, 'activate_rejected'))
    )
    throw new ApiError(httpStatus.BAD_REQUEST, 'Real names cannot be activated.')
  }
  user!.pseudonyms.forEach((p) => {
    p.active = false
  })
  target.active = true
  await user!.save()
  const activatedPseudo = user!.pseudonyms.find((p) => p.token === requestBody.token)
  if (activatedPseudo && !activatedPseudo.funFact) {
    const funFact = await generatePseudonymFunFact(activatedPseudo.pseudonym)
    if (funFact) {
      activatedPseudo.funFact = funFact
      await user!.save()
    }
  }
  return user
}
/**
 * Delete a pseudonym
 *
 * A real-name entry (isRealName: true) can never be deleted, soft or hard — a room
 * looks a member's real name up by conversation id through this same entry (see
 * message.service.ts's fetchConversation, and any future member-roster/display
 * feature), so deleting it would orphan that lookup.
 * @param {Object} requestBody
 * @param {Object} user
 * @returns {Promise<void>}
 */
const deletePseudonym = async (pseudonymId, requestUser) => {
  const user = await User.findById(requestUser.id)
  const pseudo = user!.pseudonyms.id(pseudonymId)
  if (!pseudo) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Pseudonym not found')
  }
  if (pseudo.isRealName) {
    // The room resolves through this entry (fetchConversation excludes real names
    // from its posting-gate lookup, but a member-facing roster/display feature is
    // expected to key off it) — deleting it would orphan that lookup.
    await Promise.all(
      pseudo.conversations.map((conversationId) => recordRealNameAudit(user!.id, conversationId, 'delete_rejected'))
    )
    throw new ApiError(httpStatus.BAD_REQUEST, 'Real name entries cannot be deleted.')
  }
  // Check if pseudonym is used on any messages. If it is, then
  // soft delete it. If not, hard delete, since if can be used again.
  const messages = await Message.find({ pseudonymId })
  if (messages.length > 0) {
    pseudo!.isDeleted = true
  } else {
    user!.pseudonyms.id(pseudonymId)!.deleteOne()
  }
  await user!.save()
}
/**
 * Set a user's role. Separate from the general user update so that granting privileges is
 * always a deliberate call rather than a field that rides along with a profile change.
 * @param {ObjectId} userId
 * @param {String} role - must be one of the roles in config/roles
 * @returns {Promise<User>}
 */
const updateUserRole = async (userId, role) => {
  const user = await User.findById(userId)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  user.role = role
  await user.save()
  return user
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

/**
 * Get user preferences
 * @param {Object} userId
 * @returns {Promise<Object>}
 */
const getPreferences = async (userId) => {
  const user = await getUserById(userId)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }
  return user.preferences || {}
}

/**
 * Update user preferences
 * @param {Object} userId
 * @param {Object} updateBody
 * @returns {Promise<Object>}
 */
const updatePreferences = async (userId, updateBody) => {
  const user = await getUserById(userId)
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found')
  }

  user.preferences = {
    ...user.preferences,
    ...(updateBody.visualResponse !== undefined && { visualResponse: updateBody.visualResponse }),
    ...(updateBody.jargonClarification !== undefined && { jargonClarification: updateBody.jargonClarification })
  }
  user.markModified('preferences')
  await user.save()
  return user.preferences
}

/**
 * Find-or-create all system accounts listed in the SYSTEM_USERS env var.
 * Safe to call on every startup; skips accounts that already exist.
 */
const ensureSystemUsers = async (): Promise<void> => {
  for (const { username, role } of config.systemUsers) {
    let user = await User.findOne({ username })
    if (!user) {
      user = await User.create({
        username,
        role,
        pseudonyms: [{ token: newToken(), pseudonym: username, active: true }]
      })
      logger.info(`Created system user: ${username} (${role})`)
    }
  }
}

const userService = {
  createUser,
  updateUser,
  queryUsers,
  getUserById,
  updateUserRole,
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
  hashPassword,
  getPreferences,
  updatePreferences,
  ensureSystemUsers
}
export default userService
