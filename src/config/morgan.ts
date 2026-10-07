import morgan from 'morgan'
import logger from './logger.js'

morgan.token('message', (req, res) => res.locals.errorMessage || '')
// No client IP: these lines are forwarded to Sentry, and a visitor's address is personal data.
const successResponseFormat = ':method :url :status - :response-time ms'
const errorResponseFormat = ':method :url :status - :response-time ms - message: :message'
const morganSuccessHandler = morgan(successResponseFormat, {
  skip: (req, res) => res.statusCode >= 400 || req.originalUrl === '/v1/health',
  stream: { write: (message) => logger.info(message.trim()) }
})
const morganErrorHandler = morgan(errorResponseFormat, {
  skip: (req, res) => res.statusCode < 400,
  stream: { write: (message) => logger.error(message.trim()) }
})
export { morganSuccessHandler, morganErrorHandler }
