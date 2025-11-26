import httpStatus from 'http-status'
import catchAsync from '../../utils/catchAsync.js'
import { pollService } from '../../services/index.js'

const createPoll = catchAsync(async (req, res) => {
  const poll = await pollService.createPoll(req.body, req.user)
  return res.status(httpStatus.CREATED).send(poll)
})
// TODO: Query and sorting params structure? Evaluate existing structure. Set up query param parsing elsewhere
const listPolls = catchAsync(async (req, res) => {
  let sortDir = -1
  let sort = req.query._sort
  if (sort) {
    if (sort.charAt(0) === '-') {
      sort = sort.substring(1)
      sortDir = -1
    } else {
      sortDir = 1
    }
  }
  if (sort) {
    delete req.query._sort
  } else {
    sort = 'updatedAt'
  }
  for (const prop in req.query) {
    if (['true', 'false'].includes(req.query[prop])) {
      req.query[prop] = req.query[prop] === 'true'
    }
  }
  const polls = await pollService.listPolls(req.query, sort, sortDir, req.user)
  return res.status(httpStatus.OK).send(polls)
})
// Not yet supported
// const validatePoll = catchAsync(async (req, res) => {
//   const response = await pollService.validatePoll(req.body, req.user)
//   return res.status(httpStatus.OK).send(poll)
// })
// choice can be a choiceId or a new choice object
const respondPoll = catchAsync(async (req, res) => {
  const pollResponse = await pollService.respondPoll(req.params.pollId, req.body.choice, req.user)
  return res.status(httpStatus.OK).send(pollResponse)
})
const inspectPoll = catchAsync(async (req, res) => {
  const poll = await pollService.inspectPoll(req.params.pollId, req.user)
  return res.status(httpStatus.OK).send(poll)
})
const getPollResponses = catchAsync(async (req, res) => {
  const pollResponses = await pollService.getPollResponses(req.params.pollId, req.user)
  return res.status(httpStatus.OK).send(pollResponses)
})
const getPollResponseCounts = catchAsync(async (req, res) => {
  const pollResponseCounts = await pollService.getPollResponseCounts(req.params.pollId, req.user)
  return res.status(httpStatus.OK).send(pollResponseCounts)
})

const pollController = { createPoll, listPolls, respondPoll, inspectPoll, getPollResponses, getPollResponseCounts }
export default pollController
