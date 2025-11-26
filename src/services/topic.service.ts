import crypto from 'crypto'
import httpStatus from 'http-status'
import { Topic, Follower } from '../models/index.js'
import emailService from './email.service.js'
import tokenService from './token.service.js'
import Token from '../models/token.model.js'
import ApiError from '../utils/ApiError.js'
import config from '../config/config.js'
import updateDocument from '../utils/updateDocument.js'
import User from '../models/user.model/user.model.js'
import { ITopic } from '../types/index.types.js'
import { ConversationDocument } from '../models/conversation.model.js'
import { TopicDocument } from '../models/topic.model.js'

/**
 * Query topics and add sorting properties
 * @param {Object} topicQuery
 * @returns {Promise<Array>}
 */
const topicsWithSortData = async (topicQuery) => {
  const dbtopics = await Topic.find(topicQuery)
    // Populate conversations and messages for calculation of sorting properties
    .populate({
      path: 'conversations',
      select: 'id',
      populate: [{ path: 'messages', select: ['id', 'createdAt'], match: { visible: true } }]
    })
    .select('name slug private votingAllowed conversationCreationAllowed archiveEmail owner')
    .exec()

  const topics: Array<ITopic> = await Promise.all(
    dbtopics.map(async (t) => {
      const messageCounts = await Promise.all(t.conversations.map((c) => (c as ConversationDocument).messageCount()))
      const msgCount = messageCounts.reduce((acc, val) => acc + val, 0)

      const conversationMsgTimes: Array<Date> = []
      t.conversations.forEach((conversation) => {
        if (conversation.messages && conversation.messages.length > 0) {
          conversationMsgTimes.push(conversation.messages.slice(-1)[0].createdAt!)
        }
      })

      // Create a new POJO for return, since mongoose does not allow for random properties to be set.
      const topic = t.toObject() as ITopic

      // Sort the most recent messages for all conversations, to determine the most recent message for the topic
      conversationMsgTimes.sort((a, b) => b.getTime() - a.getTime())
      topic.latestMessageCreatedAt = conversationMsgTimes.length > 0 ? conversationMsgTimes[0] : undefined
      topic.messageCount = msgCount
      topic.conversationCount = t.conversations.length
      topic.defaultSortAverage = 0
      // Calculate default sort avg as (message activity x recency)
      if (topic.latestMessageCreatedAt && topic.messageCount) {
        const msSinceEpoch = new Date(topic.latestMessageCreatedAt).getTime()
        topic.defaultSortAverage = msSinceEpoch * topic.messageCount
      }
      return topic
    })
  )

  return topics.sort((a, b) => b.defaultSortAverage! - a.defaultSortAverage!)
}
/**
 * Create a topic
 * @param {Object} topicBody
 * @param {Object} user
 * @returns {Promise<Topic>}
 */
const createTopic = async (topicBody, user) => {
  const randomPasscode = async (min, max) =>
    new Promise((resolve, reject) => {
      crypto.randomInt(min, max, (err, res) => {
        if (err) reject(err)
        resolve(res)
      })
    })
  let passcode: unknown | null = null
  if (topicBody.private) {
    passcode = await randomPasscode(1000000, 9999999)
  }

  const topic = await Topic.create({
    name: topicBody.name,
    votingAllowed: topicBody.votingAllowed,
    conversationCreationAllowed: topicBody.conversationCreationAllowed,
    private: config.enablePublicChannelCreation ? topicBody.private : true,
    archivable: topicBody.archivable,
    archiveEmail: topicBody.archiveEmail,
    passcode,
    owner: user
  })
  return topic
}
/**
 * Update a topic
 * @param {Object} topicBody
 * @returns {Promise<Topic>}
 */
const updateTopic = async (topicBody) => {
  let topicDoc = await Topic.findById(topicBody.id)
  if (!topicDoc) {
    throw new ApiError(httpStatus.NOT_FOUND, `Topic with id ${topicBody.id} not found`)
  }
  topicDoc = updateDocument(topicBody, topicDoc)
  await topicDoc!.save()
  return topicDoc
}
const userTopics = async (user) => {
  const followedTopics = await Follower.find({ user }).select('topic').exec()
  const followedTopicIds = followedTopics.map((el) => el.topic).filter((el) => el)
  const topics = await topicsWithSortData({
    $and: [
      { $or: [{ owner: user }, { _id: { $in: followedTopicIds } }] },
      {
        isDeleted: false
      }
    ]
  })
  topics.forEach((topic) => {
    if (followedTopicIds.map((f) => f.toString()).includes(topic.id!)) {
      // eslint-disable-next-line no-param-reassign
      topic.followed = true
    }
  })
  return topics
}
const allPublicTopics = async () => {
  const topics = await topicsWithSortData({ isDeleted: false, private: false })
  return topics
}
const allTopicsByUser = async (user) => {
  const otherPrivateTopics = await Topic.find({ $and: [{ private: true }, { owner: { $ne: user } }] })
  const topics = await topicsWithSortData({
    $and: [{ isDeleted: false }, { _id: { $nin: otherPrivateTopics.map((x) => x._id) } }]
  })
  return topics
}
const findById = async (id) => {
  const topic = await Topic.findOne({ _id: id })
    .populate('followers')
    .select('name slug private votingAllowed conversationCreationAllowed owner')
    .exec()
  return topic
}
/**
 * Soft delete a topic
 * @param {Object} topicBody
 * @returns {Promise}
 */
const deleteTopic = async (id) => {
  const topic = await Topic.findOne({ _id: id })
  if (!topic) throw new ApiError(httpStatus.NOT_FOUND, 'Channel does not exist')
  topic.isDeleted = true
  await topic.save()
}
const verifyPasscode = async (topicId, passcode) => {
  const topic = await Topic.findById(topicId)
  if (!topic) {
    throw new ApiError(httpStatus.NOT_FOUND, `Topic with id ${topicId} not found`)
  }
  return passcode === topic.passcode
}
/**
 * Filter out a topic that has recent message activity occurring after targetDate
 * @param {Topic} topic
 * @param {Date} targetDate
 * @returns {Promise}
 */
const activeTopicFilter = (topic, targetDate) => {
  const conversationMsgTimes: Array<Date> = []
  topic.conversations.forEach((conversation) => {
    if (conversation.messages && conversation.messages.length > 0) {
      // Get the createdAt datetime for the final message,
      // which will always be the most recent as it is pushed
      // to Conversation.messages upon message creation.
      conversationMsgTimes.push(conversation.messages.slice(-1)[0].createdAt)
    }
  })
  conversationMsgTimes.sort((a, b) => b.getTime() - a.getTime())
  const latestMessageCreatedAt = conversationMsgTimes.length > 0 ? new Date(conversationMsgTimes[0].toString()) : null
  if (latestMessageCreatedAt && latestMessageCreatedAt > targetDate) {
    // Remove this topic from deletion, since it has recent messages
    return false
  }
  return true
}
/**
 * Soft delete all topics that haven't been active for 97 days
 * @returns {Promise}
 */
const deleteOldTopics = async () => {
  // Set target date
  const targetDeletionDate = new Date()
  targetDeletionDate.setDate(targetDeletionDate.getDate() - 97)
  // Get all deletable topics
  const topics = await Topic.find({ isDeleted: false, archived: false, createdAt: { $lte: targetDeletionDate } })
    // Populate conversations and messages
    .populate({
      path: 'conversations',
      select: 'id',
      populate: [{ path: 'messages', select: ['id', 'createdAt'], match: { visible: true } }]
    })
    .exec()
  // Filter out topics that have recent activity
  const deletableTopics = topics.filter(activeTopicFilter)
  const toSave: Array<TopicDocument> = []
  for (let x = 0; x < deletableTopics.length; x++) {
    // Save topic as deleted
    await deletableTopics[x].save()
    deletableTopics[x].isDeleted = true
    toSave.push(deletableTopics[x])
  }
  await Promise.all(toSave.map((t) => t.save()))
  return deletableTopics
}
/**
 * Prompt users to archive all topics that haven't been active for 97 days
 * and are archivable.
 * @returns {Promise}
 */
const emailUsersToArchive = async () => {
  // Set target date
  const targetDeletionDate = new Date()
  targetDeletionDate.setDate(targetDeletionDate.getDate() - 90)
  // Get all deletable topics
  const topics = await Topic.find({
    isArchiveNotified: false,
    isDeleted: false,
    archived: false,
    archivable: true,
    createdAt: { $lte: targetDeletionDate }
  })
    // Populate conversations and messages
    .populate({
      path: 'conversations',
      select: 'id',
      populate: [{ path: 'messages', select: ['id', 'createdAt'], match: { visible: true } }]
    })
    .exec()

  // Filter out topics that have recent activity
  const archivableTopics = topics.filter(activeTopicFilter)
  const returnTopics: Array<ITopic> = []
  const promises = archivableTopics.map(async (archivableTopic) => {
    const topic = archivableTopic
    const owner = await User.findById(topic.owner)
    const emailAddress = topic.archiveEmail ? topic.archiveEmail : owner!.email
    if (emailAddress) {
      const archiveToken = await tokenService.generateArchiveTopicToken(owner)
      await emailService.sendArchiveTopicEmail(emailAddress, topic, archiveToken)
      topic.isArchiveNotified = true
      await topic.save()
      returnTopics.push(topic)
    }
    return true
  })
  await Promise.all(promises)
  return returnTopics
}
const archiveTopic = async (token, topicId) => {
  const topic = await Topic.findById(topicId)
  if (!topic) {
    throw new Error('Topic not found')
  }
  topic.archived = true
  await topic.save()
  await Token.deleteOne({ token })
}
/**
 * Follow or unfollow a topic
 * @param {Boolean} status
 * @param {String} topicId
 * @param {String} user
 * @returns {Promise}
 */
const follow = async (status, topicId, user) => {
  const topic = await findById(topicId)
  if (!topic) {
    throw new ApiError(httpStatus.NOT_FOUND, `Topic with id ${topicId} not found`)
  }
  const params = {
    user,
    topic
  }
  if (status === true) {
    const follower = await Follower.create(params)
    topic.followers.push(follower.toObject())
    topic.save()
  } else {
    await Follower.deleteMany(params)
  }
}

const topicService = {
  createTopic,
  userTopics,
  findById,
  allPublicTopics,
  allTopicsByUser,
  verifyPasscode,
  deleteOldTopics,
  emailUsersToArchive,
  archiveTopic,
  deleteTopic,
  updateTopic,
  follow
}
export default topicService
