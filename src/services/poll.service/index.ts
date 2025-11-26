import escapeStringRegexp from 'escape-string-regexp'
import mongoose from 'mongoose'
import httpStatus from 'http-status'
import logger from '../../config/logger.js'
import { Topic, Poll, PollChoice, PollResponse } from '../../models/index.js'
import ApiError from '../../utils/ApiError.js'
import WHEN_RESULTS_VISIBLE from '../../models/poll.model/constants.js'
import websocketGateway from '../../websockets/websocketGateway.js'
import { IPollChoice } from '../../types/index.types.js'

const createPoll = async (pollBody, user) => {
  if (!pollBody.topicId) throw new ApiError(httpStatus.BAD_REQUEST, 'Topic ID must be passed in request body')
  const topicId = new mongoose.Types.ObjectId(pollBody.topicId)
  const topic = await Topic.findById(topicId)
  if (!topic) {
    throw new ApiError(httpStatus.NOT_FOUND, `Topic with id ${topicId} not found`)
  }
  // TODO: Confirm if we want to separately allow control of conversation and poll creation or not
  // For this MVP we are using conversationCreationAllowed, but it should probably be renamed
  // spaceCreationAllowed or separated into two options for clarity
  if (!topic.conversationCreationAllowed && user._id.toString() !== topic.owner.toString()) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Poll creation not allowed.')
  }
  let choices
  if (pollBody.choices) choices = pollBody.choices
  const pollData = {
    ...pollBody,
    owner: user._id,
    topic
  }
  delete pollData.topicId
  if (
    [WHEN_RESULTS_VISIBLE.THRESHOLD_ONLY, WHEN_RESULTS_VISIBLE.ALWAYS].includes(pollData.whenResultsVisible) &&
    pollData.expirationDate
  )
    delete pollData.expirationDate
  if (
    [WHEN_RESULTS_VISIBLE.EXPIRATION_ONLY, WHEN_RESULTS_VISIBLE.ALWAYS].includes(pollData.whenResultsVisible) &&
    pollData.threshold
  )
    delete pollData.threshold
  if (
    [WHEN_RESULTS_VISIBLE.THRESHOLD_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(
      pollData.whenResultsVisible
    ) &&
    !pollData.threshold
  )
    throw new ApiError(httpStatus.BAD_REQUEST, 'Must provide threshold for this type of poll')
  if (
    [WHEN_RESULTS_VISIBLE.EXPIRATION_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(
      pollData.whenResultsVisible
    ) &&
    !pollData.expirationDate
  )
    throw new ApiError(httpStatus.BAD_REQUEST, 'Must provide expirationDate for this type of poll')
  const poll = await Poll.create(pollData)
  if (choices) {
    await PollChoice.create(choices.map((c) => ({ ...c, poll })))
  }
  // NOTE! We specifically do NOT save polls in the topic objects because
  // it is important that poll owners not be exposed (in contrast with conversations)
  // WEe can still look up polls for a topic with a query if needed
  // NO: topic.polls.push(poll.toObject())
  // NO: await topic.save()
  logger.info('Created poll %s %s %s', poll._id, poll.title, choices?.length ?? 0)
  websocketGateway.broadcastNewPoll(poll)
  return poll
}
const findById = async (pollId) => {
  const poll = await Poll.findById(pollId)
  return poll
}
const getUserPollView = (poll, user) => {
  if (!poll) return null
  // logger.info('Get user poll view %s %s', poll?._id, user._id)
  const pollData = poll?.toObject ? poll.toObject() : poll
  // how poll owner data from others
  if (!user._id.equals(poll.owner._id)) delete pollData.owner
  return pollData
}
// TODO: Query and sorting params structure? Evaluate existing structure...
const listPolls = async (query, sort, sortDir, user) => {
  const polls = await Poll.find(query).sort({ [sort]: sortDir })
  logger.info('List polls %s %s %s %s', query, sort, sortDir, polls.length)
  return polls.map((poll) => getUserPollView(poll, user))
}
// Not yet supported
// function validatePoll(poll, validator, response) {
// }
// choice can be a choiceId or a new choice object
const respondPoll = async (pollId, choiceData, user) => {
  if (!user) {
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Please log in to participate in this poll.')
  }
  const poll = await Poll.findById(pollId)
  if (!poll) throw new ApiError(httpStatus.NOT_FOUND, 'No such poll')
  // cannot respond to an expired poll
  const nowTime = Date.now()
  if (
    [WHEN_RESULTS_VISIBLE.EXPIRATION_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(
      poll.whenResultsVisible
    ) &&
    nowTime > poll.expirationDate!.getTime()
  )
    throw new ApiError(httpStatus.FORBIDDEN, 'Expiration date has been reached. No more responses are allowed.')
  const text = choiceData.text.trim()
  if (!text) throw new ApiError(httpStatus.BAD_REQUEST, 'Poll choice is required')

  // find by case insensitive text match for robustness
  // eslint-disable-next-line security/detect-non-literal-regexp
  const textRegex = new RegExp(`^${escapeStringRegexp(text)}$`, 'i')
  // find existing choice or create a new one
  let choice = await PollChoice.findOne({ poll: poll._id, text: textRegex })
  if (!poll.allowNewChoices && !choice) throw new ApiError(httpStatus.BAD_REQUEST, 'Only existing poll choices are allowed')
  if (!choice)
    choice = new PollChoice({
      ...choiceData,
      poll
    })
  if (choice.isModified()) await choice.save()
  // cannot respond to threshold only poll choice that has been reached
  if (poll.whenResultsVisible === WHEN_RESULTS_VISIBLE.THRESHOLD_ONLY) {
    const numResponses = await PollResponse.countDocuments({ poll: pollId, choice: choice._id })
    if (numResponses >= (poll.threshold || 0))
      throw new ApiError(httpStatus.FORBIDDEN, 'Threshold has been reached. No more responses are allowed.')
  }
  const pollResponseData = {
    owner: user,
    poll,
    choice
  }
  // check for existing response or create a new one
  const response = (await PollResponse.findOne(pollResponseData)) || new PollResponse(pollResponseData)
  // can remove an existing choice if before expiration
  if (choiceData.remove && !response.isModified()) {
    await PollResponse.findByIdAndDelete({ _id: response._id })
    const responseData = response.replaceObjectsWithIds()
    responseData.removed = true
    return responseData
  }
  if (!poll.multiSelect) {
    const existingOtherResponse = await PollResponse.findOne({
      poll: poll._id,
      owner: user._id,
      choice: { $ne: choice._id }
    })
    if (existingOtherResponse) throw new ApiError(httpStatus.BAD_REQUEST, 'Only one response is allowed for this poll')
  }
  if (response.isModified()) await response.save()
  logger.info('Response poll %s %s', pollId, user._id, choice._id)
  const responseWithIds = response.replaceObjectsWithIds()
  websocketGateway.broadcastNewPollChoice(poll.topic, responseWithIds)
  return responseWithIds
}
const inspectPoll = async (pollId, user) => {
  const [poll, choices] = await Promise.all([Poll.findById(pollId), PollChoice.find({ poll: pollId }).sort({ text: 1 })])
  if (!poll) {
    throw new ApiError(httpStatus.NOT_FOUND, `Poll with id ${pollId} not found`)
  }

  logger.info('Inspect poll %s %s', pollId, user._id)
  const pollData = poll.toObject()
  const userResponses = await PollResponse.find({ poll: poll._id, owner: user._id })
  // Add a boolean "isSelected" as true to each choice if the user has selected it
  if (poll.choicesVisible) {
    pollData.choices = choices.map((choice) => ({
      ...choice.toObject(),
      isSelected: userResponses.some((response) => {
        const choiceId =
          response.choice instanceof mongoose.Types.ObjectId ? response.choice : (response.choice as IPollChoice)._id
        return choiceId!.equals(choice._id)
      })
    }))
  }
  const userPollView = await getUserPollView(pollData, user)
  return userPollView
}
const getUserPollResponseView = (poll, pollResponse, user, userChoiceMap, allResponseCountMap) => {
  // logger.info('Get user poll view %s %s', poll?._id, user._id)
  const pollResponseData = pollResponse.toObject()
  const choiceId = pollResponseData.choice._id.toString()
  // check threshold and own choices filters
  if (
    ([WHEN_RESULTS_VISIBLE.THRESHOLD_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(
      poll.whenResultsVisible
    ) &&
      allResponseCountMap[choiceId] < poll.threshold) ||
    (poll.onlyOwnChoicesVisible && !userChoiceMap[choiceId])
  )
    return null
  pollResponseData.owner = pollResponseData.owner.username
  pollResponseData.choice = pollResponseData.choice.text
  return pollResponseData
}
// this collects all visible poll responses, based on the poll options and user
// returns both visible poll responses as well as visible poll counts when allowed by our poll logic
const collectVisiblePollResponses = async (poll, user) => {
  if (!poll) throw new ApiError(httpStatus.NOT_FOUND, 'No such poll')
  const nowTime = Date.now()
  const myResponse = await PollResponse.findOne({ poll: poll._id, owner: user._id })
  if (!poll.responsesVisibleToNonParticipants && !myResponse)
    throw new ApiError(httpStatus.FORBIDDEN, 'You have not participated in this poll')
  if (
    [WHEN_RESULTS_VISIBLE.EXPIRATION_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(
      poll.whenResultsVisible
    ) &&
    nowTime < poll.expirationDate.getTime()
  )
    throw new ApiError(httpStatus.FORBIDDEN, 'Expiration date has not been reached')
  // create a map of choices from this user
  const userResponses = await PollResponse.find({ poll: poll._id, owner: user._id })
  const userChoiceMap = userResponses.reduce((map, response) => {
    // eslint-disable-next-line no-param-reassign
    map[(response.choice as IPollChoice)._id!.toString()] = true
    return map
  }, {})
  const allPollResponses = await PollResponse.find({ poll: poll._id }).populate('choice').populate('owner')
  // create maps of response counts
  const choiceMap = {}
  const allResponseCountMap = {}
  const userResponseCountMap = {}
  // all response counts, for internal processing reasons
  for (const response of allPollResponses) {
    const choiceId = (response.choice as IPollChoice)._id!.toString()
    choiceMap[choiceId] = (response.choice as IPollChoice).text
    if (allResponseCountMap[choiceId] === undefined) allResponseCountMap[choiceId] = 1
    else allResponseCountMap[choiceId]++
  }
  // create a map of visible response counts for this user
  for (const choiceId of Object.keys(allResponseCountMap)) {
    if (
      allResponseCountMap[choiceId] &&
      (!poll.onlyOwnChoicesVisible || userChoiceMap[choiceId]) &&
      (!poll.threshold || allResponseCountMap[choiceId] >= poll.threshold)
    )
      userResponseCountMap[choiceMap[choiceId]] = allResponseCountMap[choiceId]
  }
  const reachedThreshold =
    !poll.threshold || Object.keys(allResponseCountMap).some((choiceId) => allResponseCountMap[choiceId] >= poll.threshold)
  const pollResponses = allPollResponses
    .map((response) => getUserPollResponseView(poll, response, user, userChoiceMap, allResponseCountMap))
    .filter(Boolean)
  logger.info('collectVisiblePollResponses', poll._id, user._id)
  return { pollResponses, allResponseCountMap, userResponseCountMap, reachedThreshold }
}
const getPollResponses = async (pollId, user) => {
  if (!pollId) throw new ApiError(httpStatus.BAD_REQUEST, 'Must provide poll id')
  const poll = await Poll.findById(pollId)
  if (!poll) throw new ApiError(httpStatus.NOT_FOUND, 'No such poll')
  if (!poll.responsesVisible) throw new ApiError(httpStatus.FORBIDDEN, 'Responses are not visible for this poll')
  const { pollResponses, reachedThreshold } = await collectVisiblePollResponses(poll, user)
  if (
    [WHEN_RESULTS_VISIBLE.THRESHOLD_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(poll.whenResultsVisible) &&
    !reachedThreshold
  )
    throw new ApiError(httpStatus.FORBIDDEN, 'Threshold has not been reached')
  return pollResponses
}
const getPollResponseCounts = async (pollId, user) => {
  if (!pollId) throw new ApiError(httpStatus.BAD_REQUEST, 'Must provide poll id')
  const poll = await Poll.findById(pollId)
  if (!poll) throw new ApiError(httpStatus.NOT_FOUND, 'No such poll')
  if (!poll.responseCountsVisible) throw new ApiError(httpStatus.FORBIDDEN, 'Response counts are not visible for this poll')
  const { userResponseCountMap, reachedThreshold } = await collectVisiblePollResponses(poll, user)
  if (
    [WHEN_RESULTS_VISIBLE.THRESHOLD_ONLY, WHEN_RESULTS_VISIBLE.THRESHOLD_AND_EXPIRATION].includes(poll.whenResultsVisible) &&
    !reachedThreshold
  )
    throw new ApiError(httpStatus.FORBIDDEN, 'Threshold has not been reached')
  return userResponseCountMap
}

const pollService = {
  createPoll,
  findById,
  listPolls,
  respondPoll,
  inspectPoll,
  getPollResponses,
  getPollResponseCounts,
  getUserPollView
}
export default pollService
