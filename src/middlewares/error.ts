import mongoose from 'mongoose'
import httpStatus from 'http-status'
import config from '../config/config.js'
import logger from '../config/logger.js'
import ApiError from '../utils/ApiError.js'

const errorConverter = (err, req, res, next) => {
  let error = err.originalError || err
  if (!(error instanceof ApiError)) {
    const statusCode =
      error.statusCode || (error instanceof mongoose.Error ? httpStatus.BAD_REQUEST : httpStatus.INTERNAL_SERVER_ERROR)
    const message = error.message || httpStatus[statusCode]
    error = new ApiError(statusCode, message, false, err.stack)
  }
  next(error)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err
  if (config.env === 'production' && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR]
  }
  res.locals.errorMessage = err.message
  const response = {
    code: statusCode,
    message,
    ...(config.env === 'development' && { stack: err.stack })
  }
  if (config.env === 'development') {
    logger.error(err)
  }
  res.status(statusCode).send(response)
}

export { errorConverter, errorHandler }
