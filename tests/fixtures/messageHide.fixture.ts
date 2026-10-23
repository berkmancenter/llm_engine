/* eslint-disable @typescript-eslint/no-explicit-any */
import mongoose from 'mongoose'
import moment from 'moment'
import config from '../../src/config/config.js'
import tokenTypes from '../../src/config/tokens.js'
import tokenService from '../../src/services/token.service.js'
import { Message, Conversation, Channel } from '../../src/models/index.js'
import { insertUsers, userOne } from './user.fixture.js'
import { insertTopics } from './topic.fixture.js'
import { conversationOne, conversationTwo, insertConversations, publicTopic } from './conversation.fixture.js'

const newParticipant = (pseudonym: string): any => ({
  _id: new mongoose.Types.ObjectId(),
  username: pseudonym.toLowerCase().replace(/\s/g, '_'),
  email: `${pseudonym.toLowerCase().replace(/\s/g, '.')}@example.com`,
  password: 'password1',
  role: 'participant',
  isEmailVerified: false,
  pseudonyms: [{ _id: new mongoose.Types.ObjectId(), pseudonym, token: pseudonym, active: true, conversations: [] }]
})

const tokenFor = (user) =>
  tokenService.generateToken(user._id, moment().add(config.jwt.accessExpirationMinutes, 'minutes'), tokenTypes.ACCESS)

const insertMessage = async (author: any, conversation: any, overrides: Record<string, unknown> = {}) =>
  Message.create({
    body: `message by ${author.pseudonyms[0].pseudonym}`,
    conversation: conversation._id,
    channels: ['chat'],
    owner: author._id,
    pseudonym: author.pseudonyms[0].pseudonym,
    pseudonymId: author.pseudonyms[0]._id,
    ...overrides
  })

/**
 * One admin, a hideable author and another participant in conversationOne, with a thread:
 *   authorMsg ── reply (by other)
 *   otherMsg
 * and one message by the author in conversationTwo, which hiding in conversationOne must never touch.
 */
const seedHideScenario = async () => {
  const admin = userOne
  const author = newParticipant('Quiet Quokka')
  const other = newParticipant('Brisk Badger')
  await insertUsers([admin, author, other])
  await insertTopics([publicTopic])
  await insertConversations([conversationOne, conversationTwo])
  // hiding applies to the group chat channel only; `assistant` stands in for any other channel
  const chatOne = await Channel.create({ name: 'chat', passcode: null })
  const assistantOne = await Channel.create({ name: 'assistant', passcode: null })
  const chatTwo = await Channel.create({ name: 'chat', passcode: null })
  await Conversation.updateOne({ _id: conversationOne._id }, { channels: [chatOne._id, assistantOne._id] })
  await Conversation.updateOne({ _id: conversationTwo._id }, { channels: [chatTwo._id] })
  const authorMsg = await insertMessage(author, conversationOne)
  const reply = await insertMessage(other, conversationOne, { parentMessage: authorMsg._id })
  const otherMsg = await insertMessage(other, conversationOne)
  const authorMsgElsewhere = await insertMessage(author, conversationTwo)
  return {
    admin,
    author,
    other,
    authorMsg,
    reply,
    otherMsg,
    authorMsgElsewhere,
    adminToken: tokenFor(admin),
    authorToken: tokenFor(author),
    otherToken: tokenFor(other)
  }
}

export { newParticipant, tokenFor, insertMessage, seedHideScenario, conversationOne, conversationTwo, Conversation }
