import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { resourceService } from '../services/index.js'

const uploadPdf = catchAsync(async (req, res) => {
  if (!req.file) {
    res.status(httpStatus.BAD_REQUEST).send({ message: 'No PDF file provided' })
    return
  }
  await resourceService.savePdf(req.params.conversationId, req.params.resourceId, req.file.buffer, req.user)
  res.status(httpStatus.NO_CONTENT).send()
})

// eslint-disable-next-line import/prefer-default-export
export { uploadPdf }
