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

const getTranscript = catchAsync(async (req, res) => {
  const timezone = req.headers['x-timezone'] || 'UTC'
  const transcript = await transcriptService.getPlainTextTranscript(req.params.conversationId, timezone)

  res.format({
    'text/plain': () => {
      res.send(transcript)
    },
    default: () => {
      res.status(httpStatus.NOT_ACCEPTABLE).send()
    }
  })
})

export { deleteTranscript, pauseTranscript, resumeTranscript, getTranscript }
