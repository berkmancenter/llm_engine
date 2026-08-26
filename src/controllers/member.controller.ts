import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import { memberService } from '../services/index.js'

const importMembers = catchAsync(async (req, res) => {
  if (!req.file) {
    res.status(httpStatus.BAD_REQUEST).send({ message: 'No file provided' })
    return
  }
  const result = await memberService.importMembersFromCsv(req.params.conversationId, req.file.buffer, req.user)
  res.status(httpStatus.OK).send(result)
})

// eslint-disable-next-line import/prefer-default-export
export { importMembers }
