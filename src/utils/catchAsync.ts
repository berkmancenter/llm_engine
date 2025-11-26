import logger from '../config/logger.js'
import WebsocketError from './WebsocketError.js'

const catchAsync = (fn) => (req, data, next) => {
  Promise.resolve(fn(req, data, next)).catch((err) => {
    // preserve and reset orginal error message because logger modifies it
    // see https://github.com/winstonjs/winston/issues/1775
    const originalErr = err
    const originalMsg = err.message
    logger.error(err)
    originalErr.message = originalMsg
    const websocketError = new WebsocketError(originalErr, data)
    if (next) {
      next(websocketError)
    }
  })
}
export default catchAsync
