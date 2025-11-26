import mongoose from 'mongoose'
import httpStatus from 'http-status'
import logger from '../config/logger.js'
import { Message, Conversation, User } from '../models/index.js'
import schedule from '../jobs/schedule.js'
import ApiError from '../utils/ApiError.js'
import websocketGateway from '../websockets/websocketGateway.js'
import { IAgent, IMessage, AgentMessageActions } from '../types/index.types.js'
import authChannels from '../utils/authChannels.js'

/**
 * Check if we can create a message and fetch conversation
 * @param {Object} messageBody
 * @param {User} user
 * @returns {Promise<Conversation>}
 */

const fetchConversation = async (messageBody, user) => {
  let { conversation } = messageBody
  if (typeof conversation === 'string' || conversation instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversation })
  } else {
    // reload the conversation within the lock to update version
    conversation = await Conversation.findOne({ _id: conversation._id })
  }
  await conversation.populate([
    { path: 'agents' },
    { path: 'channels' },
    { path: 'adapters' },
    { path: 'messages', match: { visible: true } }
  ])

  if (conversation.locked) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'This conversation is locked and cannot receive messages.')
  }
  const activePseudo = user.activePseudonym
  const pseudoForConversation = user.pseudonyms.find((x) => x.conversations.includes(conversation._id))
  if (pseudoForConversation && activePseudo._id.toString() !== pseudoForConversation._id.toString()) {
    logger.error(`CANNOT POST - CONVERSATION: ${pseudoForConversation._id}, ACTIVE: ${activePseudo._id}`)
    throw new ApiError(httpStatus.BAD_REQUEST, 'You cannot post in this conversation with your active pseudonym.')
  }
  if (!pseudoForConversation) {
    const newPseudonyms = user.pseudonyms.map((x) => {
      if (x.active) {
        x.conversations.push(conversation._id)
      }
      return x
    })
    user.pseudonyms.set(newPseudonyms)
    user.markModified('pseudonyms')
    await user.save()
  }
  return conversation
}
/**
 * Create a message
 * @param {Object} messageBody
 * @param {User} user
 * @param {Conversation} conversation
 * @returns {Promise<Message>}
 */
const createMessage = async (messageBody, user, conversation) => {
  const activePseudo = user.activePseudonym
  if (!messageBody.body) throw new ApiError(httpStatus.BAD_REQUEST, 'Message body is required')

  // handle optional channel(s) selection
  if (messageBody.channels) {
    await authChannels(messageBody.channels, conversation, user)
  }

  const message = await Message.create({
    body: messageBody.body,
    ...(messageBody.bodyType !== undefined && { bodyType: messageBody.bodyType }),
    ...(messageBody.createdAt !== undefined && { createdAt: messageBody.createdAt }),
    conversation: conversation._id,
    owner: user,
    pseudonym: activePseudo.pseudonym,
    pseudonymId: activePseudo._id,
    // TODO control this more carefully
    fromAgent: !!messageBody.fromAgent,
    source: messageBody.source,
    channels: messageBody.channels?.map((c) => c.name)
  })

  message.parseOutput = messageBody.parseOutput

  // Only set visible if it's explicitly included in the request from agent, else use default true
  if ('visible' in messageBody) {
    message.visible = !!messageBody.visible
  }
  conversation.messages.push(message.toObject())
  message.count = conversation.messages.reduce((count, msg) => count + (msg.visible ? 1 : 0), 0)
  message.pause = messageBody.pause
  return message
}

const conversationMessages = async (id, channels) => {
  if (channels?.length) {
    // check channel passcodes first, if any
    await authChannels(channels, id)
  }

  // fetch visible in the right channels, including those with no channel (main channel)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query: any = {
    conversation: id,
    visible: true,
    parentMessage: { $exists: false },
    $or: [{ channels: { $size: 0 } }, { channels: { $in: (channels || []).map((c) => c.name) } }]
  }

  const messages = await Message.find(query)
    .select('body bodyType owner upVotes downVotes pseudonym pseudonymId createdAt fromAgent source channels')
    .sort({ createdAt: 1 })
    .exec()

  // fetch reply counts
  const messageIds = messages.map((msg) => msg._id)
  const replyCounts = await Message.aggregate([
    {
      $match: {
        parentMessage: { $in: messageIds },
        visible: true
      }
    },
    {
      $group: {
        _id: '$parentMessage',
        count: { $sum: 1 }
      }
    }
  ])

  const replyCountMap = {}
  replyCounts.forEach((item) => {
    replyCountMap[item._id.toString()] = item.count
  })

  const annotatedMessages = messages.map((msg) => {
    const mId = msg._id
    const msgObj = msg.toObject({
      transform: (doc, ret) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { _id, ...cleanRet } = ret

        return {
          ...cleanRet,
          id: mId,
          replyCount: replyCountMap[msg._id.toString()] || 0
        }
      }
    })
    return msgObj
  })

  return annotatedMessages
}

/**
 * Upvote or downvote a message
 * @param {Object} messageId
 * @param {Object} direction
 * @returns {Promise<Message>}
 */
const vote = async (messageId, direction, status, requestUser) => {
  const user = await User.findById(requestUser.id)
  if (!user) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'User not found')
  }
  const message = await Message.findById(messageId)
  if (!message) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Message with ID ${messageId} not found`)
  }
  if (message.owner?.toString() === user!._id.toString()) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Users cannot vote for their own messages.')
  }
  // TODO should prevent voting to a channel to which you do not have access
  const votes = message.upVotes?.concat(message.downVotes)
  if (status) {
    if (votes && votes.length > 0) {
      const existingVote = votes.find((x) => x.owner?.toString() === user!._id.toString())
      if (existingVote) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'User has already voted for this message.')
      }
    }
  }
  if (status) {
    if (direction === 'up') {
      message.upVotes.push({ owner: user })
    } else {
      message.downVotes.push({ owner: user })
    }
  } else if (direction === 'up') {
    message.upVotes = message.upVotes.filter((vt) => vt.owner?.toString() !== user!._id.toString())
  } else {
    message.downVotes = message.downVotes.filter((vt) => vt.owner?.toString() !== user!._id.toString())
  }
  // if (status) {
  //   message.votes.push({ owner: user._id, direction: direction})
  // } else {
  //   message.votes.remove({ owner: user._id, direction: direction })
  // }
  await message.save()
  websocketGateway.broadcastNewVote(message)
  return message
}

/**
 * Handle all stages of processing a new message
 * @param {Object} message
 * @param {User} user
 * @returns {Promise<[Message]>}
 */
const newMessageHandler = async (message, user, request = null) => {
  const conversation = await fetchConversation(message, user)
  let userContributionVisible = true
  const respondingAgents: Array<IAgent> = []

  const messageWithUser = {
    ...message,
    pseudonym: user.activePseudonym.pseudonym,
    channels: message.channels?.map((c) => c.name),
    owner: user._id
  }
  if (conversation.enableAgents) {
    // process evaluations and check for any rejections. Process in priority order
    const sortedAgents = conversation.agents.sort((a, b) => a.priority - b.priority)
    for (const agent of sortedAgents) {
      // use in memory conversation for speed
      agent.conversation = conversation
      const agentEvaluation = await agent.evaluate(messageWithUser)
      if (!agentEvaluation) continue
      if (agentEvaluation.action === AgentMessageActions.REJECT) {
        logger.info(`Rejecting message: ${agentEvaluation.suggestion}`)
        throw new ApiError(httpStatus.UNPROCESSABLE_ENTITY, agentEvaluation.suggestion)
      }
      if (agentEvaluation.action === AgentMessageActions.CONTRIBUTE) respondingAgents.push(agent)
      if (!agentEvaluation.userContributionVisible) userContributionVisible = false
    }
  }
  const messages: Array<IMessage> = []
  if (userContributionVisible) {
    const sentMessage = await createMessage(message, user, conversation)
    messages.push(sentMessage)
    sentMessage.owner = user._id

    for (const adapter of conversation.adapters) {
      const adapterMsg = sentMessage.parseOutput ? sentMessage.parseOutput(sentMessage) : sentMessage
      await adapter.sendMessage(adapterMsg)
    }
    // TODO websocket should be an adapter, keeping here for now until we require messages to have channels
    websocketGateway.broadcastNewMessage(sentMessage, request)
  }
  for (const respondingAgent of respondingAgents) {
    await schedule.agentResponse({ agentId: respondingAgent._id, message: messageWithUser })
  }
  return messages
}

const getMessageReplies = async (messageId, messageQuery = {}) => {
  // Get the parent message to find the conversation
  // const parentMessage = await Message.findById(messageId).exec()
  // const conversation = await Conversation.findById(parentMessage?.conversation).populate('topic').exec()
  // const isChannelOwner = userId && conversation?.topic && conversation.topic.owner.toString() === userId.toString()

  const replies = await Message.find({
    ...messageQuery,
    parentMessage: messageId
  })
    .sort({ createdAt: 1 })
    .exec()

  return replies
}

// duplicate messages from one conversation to another
export const duplicateConversationMessages = async (conversationOrId, duplicateConversationOrId, messageQuery = {}) => {
  let conversation = conversationOrId
  if (typeof conversationOrId === 'string' || conversationOrId instanceof mongoose.Types.ObjectId) {
    conversation = await Conversation.findOne({ _id: conversationOrId })
  }

  const messages = await Message.find({ ...messageQuery, conversation: conversation._id })

  const duplicateConversationId = duplicateConversationOrId._id || duplicateConversationOrId

  const duplicatedMessages = messages.map((msg) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, ...msgData } = msg.toObject()
    const obj = {
      ...msgData,
      conversation: duplicateConversationId
    }
    return obj
  })

  await Message.insertMany(duplicatedMessages)
}

const messageService = {
  fetchConversation,
  createMessage,
  conversationMessages,
  vote,
  duplicateConversationMessages,
  newMessageHandler,
  getMessageReplies
}
export default messageService
