import httpStatus from 'http-status'
import handlers from '../handlers/index.js'
import ApiError from '../utils/ApiError.js'

const useAdapter = () => async (req, res, next) => {
  try {
    const adapter = req.path.split('/')[1]
    if (!handlers[adapter]) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Invalid adapter: ${adapter}`)
    }
    return await handlers[adapter].middleware(req, res, next)
  } catch (err) {
    next(err)
  }
}
export default useAdapter
