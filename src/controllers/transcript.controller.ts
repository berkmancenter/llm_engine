import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { transcriptService } from '../services/index.js'

const deleteTranscript = catchAsync(async (req, res) => {
  await transcriptService.deleteTranscript(req.params.conversationId, req.user)
  res.status(httpStatus.NO_CONTENT).send()
})

// eslint-disable-next-line import/prefer-default-export
export { deleteTranscript }
