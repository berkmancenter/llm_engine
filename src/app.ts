import express from 'express'
import helmet from 'helmet'
import xss from 'xss-clean'
import mongoSanitize from 'express-mongo-sanitize'
import compression from 'compression'
import cors from 'cors'
import passport from 'passport'
import httpStatus from 'http-status'
import cookieParser from 'cookie-parser'
import bodyParser from 'body-parser'
import config from './config/config.js'
import { morganSuccessHandler, morganErrorHandler } from './config/morgan.js'
import jwtStrategy from './config/passport.js'
import authLimiter from './middlewares/rateLimiter.js'
import routes from './routes/v1/index.js'
import { errorConverter, errorHandler } from './middlewares/error.js'
import ApiError from './utils/ApiError.js'
import './websockets/index.js'

const app = express()
if (config.env !== 'test') {
  app.use(morganSuccessHandler)
  app.use(morganErrorHandler)
}

// set security HTTP headers
app.use(helmet())
const rawBodyBuffer = (req, res, buf, encoding) => {
  if (buf?.length) {
    req.rawBody = buf.toString(encoding || 'utf8')
  }
}
// parse json request body
app.use(bodyParser.json({ verify: rawBodyBuffer }))
// parse urlencoded request body
app.use(bodyParser.urlencoded({ verify: rawBodyBuffer, extended: true }))

// ensure empty body for validation
app.use((req, res, next) => {
  const methodsThatShouldHaveBody = ['POST', 'PUT', 'PATCH']
  if (req.body === undefined && methodsThatShouldHaveBody.includes(req.method.toUpperCase())) {
    req.body = {}
  }
  next()
})
// sanitize request data
app.use(xss())
app.use(mongoSanitize())
// gzip compression
app.use(compression())
app.use(cookieParser())
// enable cors
app.use(cors())
app.options('*', cors())
// jwt authentication
app.use(passport.initialize())
passport.use('jwt', jwtStrategy)
// limit repeated failed requests to auth endpoints
if (config.env === 'production') {
  app.use('/v1/auth', authLimiter)
}
// v1 api routes
app.use('/v1', routes)
// send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, 'Not found'))
})
// convert error to ApiError, if needed
app.use(errorConverter)
// handle error
app.use(errorHandler)
// additional headers
app.use((req, res, next) => {
  // Website you wish to allow to connect
  res.setHeader('Access-Control-Allow-Origin', '*')
  next()
})
export default app
