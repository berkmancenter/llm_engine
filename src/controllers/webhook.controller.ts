import httpStatus from 'http-status'
import catchAsync from '../utils/catchAsync.js'
import handlers from '../handlers/index.js'
import ApiError from '../utils/ApiError.js'

const processEvent = catchAsync(async (req, res) => {
  const adapter = req.path.split('/')[1]
  if (!handlers[adapter]) {
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid or unsupported adapter: ${adapter}`)
  }
  await handlers[adapter].handleEvent(req, res)
})

export default { processEvent }
