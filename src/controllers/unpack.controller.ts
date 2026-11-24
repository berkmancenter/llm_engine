import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { unpackService } from '../services/index.js'

const previewPassage = catchAsync(async (req, res) => {
  const { transcriptPasscode, ...selection } = req.body
  const preview = await unpackService.previewPassage(req.params.conversationId, req.user, selection, transcriptPasscode)
  res.status(httpStatus.OK).send(preview)
})

const sendPassage = catchAsync(async (req, res) => {
  const { destination, transcriptPasscode, ...selection } = req.body
  const result = await unpackService.sendPassage(
    req.params.conversationId,
    req.user,
    selection,
    destination,
    transcriptPasscode
  )
  res.status(httpStatus.ACCEPTED).send(result)
})

const sharePassage = catchAsync(async (req, res) => {
  const { messageId, transcriptPasscode } = req.body
  const result = await unpackService.sharePassage(req.params.conversationId, req.user, messageId, transcriptPasscode)
  res.status(httpStatus.ACCEPTED).send(result)
})

export { previewPassage, sendPassage, sharePassage }
