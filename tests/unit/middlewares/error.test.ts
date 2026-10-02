import mongoose from 'mongoose'
import httpStatus from 'http-status'
import httpMocks from 'node-mocks-http'
import { errorConverter, errorHandler } from '../../../src/middlewares/error.js'
import ApiError from '../../../src/utils/ApiError.js'
import config from '../../../src/config/config.js'
import logger from '../../../src/config/logger.js'

interface CustomError extends Error {
  statusCode?: number
}

describe('Error middlewares', () => {
  describe('Error converter', () => {
    test('should return the same ApiError object it was called with', () => {
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error')
      const next = jest.fn()

      errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next)

      expect(next).toHaveBeenCalledWith(error)
    })

    test('should convert an Error to ApiError and preserve its status and message', () => {
      const error = new Error('Any error') as CustomError
      error.statusCode = httpStatus.BAD_REQUEST
      const next = jest.fn()

      errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next)

      expect(next).toHaveBeenCalledWith(expect.any(ApiError))
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: error.statusCode,
          message: error.message,
          isOperational: false
        })
      )
    })

    test('should convert an Error without status to ApiError with status 500', () => {
      const error = new Error('Any error')
      const next = jest.fn()

      errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next)

      expect(next).toHaveBeenCalledWith(expect.any(ApiError))
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: httpStatus.INTERNAL_SERVER_ERROR,
          message: error.message,
          isOperational: false
        })
      )
    })

    test('should convert an Error without message to ApiError with default message of that http status', () => {
      const error = new Error() as CustomError
      error.statusCode = httpStatus.BAD_REQUEST
      const next = jest.fn()

      errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next)

      expect(next).toHaveBeenCalledWith(expect.any(ApiError))
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: error.statusCode,
          message: httpStatus[error.statusCode],
          isOperational: false
        })
      )
    })

    test('should convert a Mongoose error to ApiError with status 400 and preserve its message', () => {
      const error = new mongoose.Error('Any mongoose error')
      const next = jest.fn()

      errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next)

      expect(next).toHaveBeenCalledWith(expect.any(ApiError))
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: httpStatus.BAD_REQUEST,
          message: error.message,
          isOperational: false
        })
      )
    })

    test('should convert any other object to ApiError with status 500 and its message', () => {
      const error = {}
      const next = jest.fn()

      errorConverter(error, httpMocks.createRequest(), httpMocks.createResponse(), next)

      expect(next).toHaveBeenCalledWith(expect.any(ApiError))
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: httpStatus.INTERNAL_SERVER_ERROR,
          message: httpStatus[httpStatus.INTERNAL_SERVER_ERROR],
          isOperational: false
        })
      )
    })
  })

  describe('Error handler', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      jest.spyOn(logger, 'error').mockImplementation((infoObject: object) => logger)
    })

    test('should send proper error response and put the error message in res.locals', () => {
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error')
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ code: error.statusCode, message: error.message }))
      expect(res.locals.errorMessage).toBe(error.message)
    })

    test("should include the error's reason so a client can tell apart refusals with the same status", () => {
      const error = new ApiError(httpStatus.CONFLICT, 'That name is taken.', { reason: 'real_name_taken' })
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ code: httpStatus.CONFLICT, reason: 'real_name_taken' }))
    })

    test('should leave the reason out of the response when the error has none', () => {
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error')
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy.mock.calls[0][0]).not.toHaveProperty('reason')
    })

    test('should drop the reason when production hides a non-operational error', () => {
      config.env = 'production'
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error', { isOperational: false, reason: 'real_name_taken' })
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy.mock.calls[0][0]).not.toHaveProperty('reason')
      config.env = process.env.NODE_ENV
    })

    test('should put the error stack in the response if in development mode', () => {
      config.env = 'development'
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error')
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ code: error.statusCode, message: error.message, stack: error.stack })
      )
      config.env = process.env.NODE_ENV
    })

    test('should send internal server error status and message if in production mode and error is not operational', () => {
      config.env = 'production'
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error', { isOperational: false })
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: httpStatus.INTERNAL_SERVER_ERROR,
          message: httpStatus[httpStatus.INTERNAL_SERVER_ERROR]
        })
      )
      expect(res.locals.errorMessage).toBe(error.message)
      config.env = process.env.NODE_ENV
    })

    test('should preserve original error status and message if in production mode and error is operational', () => {
      config.env = 'production'
      const error = new ApiError(httpStatus.BAD_REQUEST, 'Any error')
      const res = httpMocks.createResponse()
      const sendSpy = jest.spyOn(res, 'send')

      errorHandler(error, httpMocks.createRequest(), res, () => {})

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          code: error.statusCode,
          message: error.message
        })
      )
      config.env = process.env.NODE_ENV
    })
  })
})
