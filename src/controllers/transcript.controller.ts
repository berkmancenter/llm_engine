import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { transcriptService } from '../services/index.js'

const deleteTranscript = catchAsync(async (req, res) => {
  await transcriptService.deleteTranscript(req.params.conversationId, req.user)
  res.status(httpStatus.NO_CONTENT).send()
})

const pauseTranscript = catchAsync(async (req, res) => {
  await transcriptService.pauseTranscript(req.params.conversationId, req.user)
  res.status(httpStatus.NO_CONTENT).send()
})

const resumeTranscript = catchAsync(async (req, res) => {
  await transcriptService.resumeTranscript(req.params.conversationId, req.user)
  res.status(httpStatus.NO_CONTENT).send()
})

export { deleteTranscript, pauseTranscript, resumeTranscript }
