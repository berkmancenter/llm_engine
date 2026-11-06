import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { unpackService } from '../services/index.js'

const previewPassage = catchAsync(async (req, res) => {
  const preview = await unpackService.previewPassage(req.params.conversationId, req.user, req.body)
  res.status(httpStatus.OK).send(preview)
})

const sendPassage = catchAsync(async (req, res) => {
  const { destination, ...selection } = req.body
  const result = await unpackService.sendPassage(req.params.conversationId, req.user, selection, destination)
  res.status(httpStatus.ACCEPTED).send(result)
})

export { previewPassage, sendPassage }
